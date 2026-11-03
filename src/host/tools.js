// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Agent tools: process-internal access to the Lean language server.
 *
 * Why not HTTP: the WebSocket/web server route is gated by
 * `connection.requestRejection()`, so a plain `fetch` from the host process gets
 * 403. Registering real tools instead means the agent calls `handle()` in-process
 * — no HTTP, no auth, no session token to borrow.
 *
 * Conventions the model must be able to rely on:
 *   - every `line`/`character` argument is **1-based** (LSP itself is 0-based);
 *   - results are plain JSON (no LSP `uri`s in the happy path);
 *   - failures come back as `{ status: 'error', code, message }` instead of throwing.
 */

/** Every tool this module registers. Kept exported so tests can assert the set. */
export const LEAN_TOOL_NAMES = [
  'lean_diagnostics',
  'lean_goal',
  'lean_hover',
  'lean_completion',
  'lean_definition',
  'lean_references',
  'lean_code_actions',
  'lean_outline',
  'lean_search',
];

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status', 'code', 'message'],
};

const POSITION_PROPS = {
  line: { type: 'integer', description: '1-based line number.' },
  character: { type: 'integer', description: '1-based column number (UTF-16 code units, like an editor caret).' },
};

const PATH_PROP = {
  type: 'string',
  description: 'Lean source file. Relative paths resolve against the DSH working directory.',
};

const WAIT_PROP = {
  type: 'integer',
  description: 'How long to wait for Lean to finish elaborating before reading, in milliseconds. Default 10000.',
};

/** LSP `SymbolKind` → short label, for compact outline lines. */
const SYMBOL_KINDS = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  22: 'struct',
  23: 'event',
  26: 'typeParam',
};

const MAX_IDLE_WAIT_MS = 60_000;

function objectSchema(properties, required) {
  return { type: 'object', additionalProperties: false, properties, required };
}

/** `{status:'ok', …}` in the happy path, `{status:'error', …}` otherwise. */
function okSchema(properties, required) {
  return {
    oneOf: [
      objectSchema({ status: { type: 'string', const: 'ok' }, ...properties }, ['status', ...required]),
      ERROR_SCHEMA,
    ],
  };
}

function text(value) {
  return [{ type: 'text', text: value }];
}

function errorValue(code, message) {
  return { status: 'error', code, message };
}

/** `line:character` from a 0-based LSP position, printed 1-based. */
function formatPosition(position) {
  const line = Number(position?.line);
  const character = Number(position?.character);
  return `${Number.isFinite(line) ? line + 1 : 1}:${Number.isFinite(character) ? character + 1 : 1}`;
}

function formatRange(range) {
  const start = formatPosition(range?.start);
  const end = formatPosition(range?.end);
  return start === end ? start : `${start}-${end}`;
}

function symbolKindLabel(kind) {
  return SYMBOL_KINDS[Number(kind)] ?? `kind${Number(kind) || 0}`;
}

/** Trim a single-line preview so one huge `newText` cannot flood the transcript. */
function clip(value, max = 80) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Validate a 1-based position and convert it to the 0-based LSP shape.
 * @returns `{line, character}` or an error value.
 */
function lspPosition(args) {
  const line = Number(args.line);
  const character = Number(args.character);
  if (!Number.isInteger(line) || line < 1) return { error: errorValue('invalid-args', '`line` must be a 1-based integer') };
  if (!Number.isInteger(character) || character < 1) {
    return { error: errorValue('invalid-args', '`character` must be a 1-based integer') };
  }
  return { position: { line: line - 1, character: character - 1 } };
}

function severityLabel(value) {
  switch (Number(value)) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'error';
  }
}

/**
 * Build the tool definitions.
 *
 * @param {object} bridge
 * @param {(raw: string) => string} bridge.resolvePath   absolute path for a tool argument.
 * @param {() => Promise<string>} bridge.anchor          falls back to some `.lean` file for `lean_search`.
 * @param {(path: string, options?: {wait?: boolean, timeoutMs?: number}) => Promise<{settled: boolean, waitedMs: number, notes: string[]}>} bridge.prepare
 *        makes the server hold the current text, optionally waiting for elaboration.
 * @param {(op: string, body: object) => Promise<{ok: boolean, value?: any, error?: {code: string, message: string}}>} bridge.run
 *        the same `handle()` the browser uses.
 */
export function createLeanTools(bridge) {
  const MAX_LISTED = 60;

  /** Wrap `bridge.run` so tools never see the `{ok, value}` envelope. */
  async function run(op, body) {
    const result = await bridge.run(op, body);
    if (result?.ok !== true) {
      const code = typeof result?.error?.code === 'string' ? result.error.code : 'lean-failed';
      const message = typeof result?.error?.message === 'string' ? result.error.message : 'Lean request failed';
      return { error: errorValue(code, message) };
    }
    return { value: result.value };
  }

  /** `prepare()` + the diagnostics snapshot, shared by the two tools that wait. */
  async function preparedDiagnostics(path, options) {
    const prepared = await bridge.prepare(path, { wait: true, ...options });
    const loaded = await run('diagnostics', { op: 'diagnostics', path });
    if (loaded.error !== undefined) return loaded;
    return { value: { prepared, diagnostics: loaded.value } };
  }

  function diagnosticsResult(path, prepared, value) {
    const all = Array.isArray(value?.diagnostics) ? value.diagnostics : [];
    /* `isSilent` 的是 Lean 给编辑器画「目标已完成」的装饰诊断，对读代码的人
       和读代码的模型都是噪音，默认剔除但要说明剔了多少。 */
    const visible = all.filter((item) => item?.isSilent !== true);
    const silent = all.length - visible.length;
    return {
      status: 'ok',
      path,
      state: typeof value?.state === 'string' ? value.state : 'unknown',
      settled: prepared?.settled === true,
      waitedMs: Number(prepared?.waitedMs) || 0,
      total: all.length,
      silent,
      diagnostics: visible.slice(0, MAX_LISTED).map((item) => ({
        line: Number(item?.startLine) + 1 || 1,
        character: Number(item?.startCharacter) + 1 || 1,
        endLine: Number(item?.endLine) + 1 || 1,
        endCharacter: Number(item?.endCharacter) + 1 || 1,
        severity: severityLabel(item?.severity),
        message: String(item?.message ?? ''),
        code: item?.code === undefined || item?.code === null ? '' : String(item.code),
      })),
      truncated: Math.max(0, visible.length - MAX_LISTED),
    };
  }

  function locationsOf(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_LISTED).map((item) => ({
      path: typeof item?.path === 'string' ? item.path : '',
      line: Number(item?.range?.start?.line) + 1 || 1,
      character: Number(item?.range?.start?.character) + 1 || 1,
    }));
  }

  /** Shared body for the six position-based tools. */
  function positionTool(spec) {
    return {
      name: spec.name,
      description: spec.description,
      parameters: objectSchema({ path: PATH_PROP, ...POSITION_PROPS }, ['path', 'line', 'character']),
      output: { schema: spec.schema, render: spec.render },
      isConcurrencySafe: () => false,
      async execute(args) {
        const parsed = lspPosition(args);
        if (parsed.error !== undefined) return parsed.error;
        const path = bridge.resolvePath(args.path);
        const prepared = await bridge.prepare(path, { wait: false });
        const position = { ...parsed.position, path };
        const result = await run(spec.op, {
          op: spec.op,
          path,
          line: position.line,
          character: position.character,
          ...(spec.body === undefined ? {} : spec.body(args)),
        });
        if (result.error !== undefined) return result.error;
        return spec.collect({ args, path, position: parsed.position, prepared, value: result.value });
      },
    };
  }

  const tools = [];

  /* ── diagnostics ──────────────────────────────────────────────────────── */
  tools.push({
    name: 'lean_diagnostics',
    description:
      'Read the Lean 4 diagnostics (errors/warnings/info) for one file. Waits for the language server to finish '
      + 'elaborating before answering, so the result reflects the current file contents. Silent "goals accomplished" '
      + 'decorations are filtered out and counted separately.',
    parameters: objectSchema(
      { path: PATH_PROP, waitMs: WAIT_PROP, severity: { type: 'string', enum: ['all', 'error', 'warning'], description: 'Filter by severity. Default all.' } },
      ['path'],
    ),
    output: {
      schema: okSchema(
        {
          path: { type: 'string' },
          state: { type: 'string' },
          settled: { type: 'boolean' },
          waitedMs: { type: 'integer' },
          total: { type: 'integer' },
          silent: { type: 'integer' },
          truncated: { type: 'integer' },
          diagnostics: {
            type: 'array',
            items: objectSchema(
              {
                line: { type: 'integer' },
                character: { type: 'integer' },
                endLine: { type: 'integer' },
                endCharacter: { type: 'integer' },
                severity: { type: 'string' },
                message: { type: 'string' },
                code: { type: 'string' },
              },
              ['line', 'character', 'severity', 'message'],
            ),
          },
        },
        ['path', 'diagnostics'],
      ),
      render(_args, value) {
        if (value.status === 'error') return text(`${value.code}: ${value.message}`);
        const counts = { error: 0, warning: 0, info: 0, hint: 0 };
        for (const item of value.diagnostics) counts[item.severity] = (counts[item.severity] ?? 0) + 1;
        const summary = Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([kind, count]) => `${count} ${kind}`)
          .join(', ');
        const head =
          `${value.path}: ${value.diagnostics.length === 0 ? '没有诊断' : summary}`
          + `（server ${value.state}${value.settled ? '' : '，等待超时、结果可能不是最新'}`
          + `${value.silent > 0 ? `，另有 ${value.silent} 条静默装饰诊断已隐藏` : ''}）`;
        const lines = value.diagnostics.map(
          (item) => `${item.line}:${item.character} ${item.severity}: ${item.message}${item.code === '' ? '' : ` [${item.code}]`}`,
        );
        if (value.truncated > 0) lines.push(`…还有 ${value.truncated} 条未列出`);
        return text([head, ...lines].join('\n'));
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const path = bridge.resolvePath(args.path);
      const waitMs = Number.isFinite(Number(args.waitMs)) ? Math.min(Math.max(Number(args.waitMs), 0), MAX_IDLE_WAIT_MS) : 10_000;
      const loaded = await preparedDiagnostics(path, { timeoutMs: waitMs });
      if (loaded.error !== undefined) return loaded.error;
      const result = diagnosticsResult(path, loaded.value.prepared, loaded.value.diagnostics);
      const severity = args.severity ?? 'all';
      if (severity === 'error' || severity === 'warning') {
        result.diagnostics = result.diagnostics.filter((item) => item.severity === severity);
      }
      return result;
    },
  });

  /* ── goal ─────────────────────────────────────────────────────────────── */
  tools.push(
    positionTool({
      name: 'lean_goal',
      op: 'goal',
      description:
        'Read the proof state (tactic goals) at one position. Place it on a tactic line inside a `by` block; '
        + 'declaration headers and finished proofs have no goals.',
      schema: okSchema(
        {
          path: { type: 'string' },
          line: { type: 'integer' },
          character: { type: 'integer' },
          goals: { type: 'array', items: { type: 'string' } },
          termGoal: { type: 'string' },
        },
        ['path', 'line', 'character', 'goals'],
      ),
      async collect({ path, position, value }) {
        const term = await run('termGoal', { op: 'termGoal', path, line: position.line, character: position.character });
        return {
          status: 'ok',
          path,
          line: position.line + 1,
          character: position.character + 1,
          goals: Array.isArray(value?.goals) ? value.goals.filter((goal) => typeof goal === 'string') : [],
          termGoal: typeof term.value?.text === 'string' ? term.value.text : '',
        };
      },
      render(args, value) {
        if (value.status === 'error') return text(`${value.code}: ${value.message}`);
        if (value.goals.length === 0) {
          return text(`${value.path}:${args.line}:${args.character} 没有打开的目标（这一行不在 tactic 里，或证明已完成）`);
        }
        return text(value.goals.join('\n\n'));
      },
    }),
  );

  /* ── hover ────────────────────────────────────────────────────────────── */
  tools.push(
    positionTool({
      name: 'lean_hover',
      op: 'hover',
      description: 'Read the type / documentation shown when hovering an identifier, as Markdown.',
      schema: okSchema({ path: { type: 'string' }, text: { type: 'string' } }, ['path', 'text']),
      async collect({ path, value }) {
        return { status: 'ok', path, text: typeof value?.text === 'string' ? value.text : '' };
      },
      render(args, value) {
        if (value.status === 'error') return text(`${value.code}: ${value.message}`);
        return text(value.text === '' ? `${value.path}:${args.line}:${args.character} 没有悬停信息` : value.text);
      },
    }),
  );

  /* ── completion ───────────────────────────────────────────────────────── */
  tools.push(
    positionTool({
      name: 'lean_completion',
      op: 'completion',
      description:
        'List Lean completions at a position. Only meaningful inside an identifier (after a prefix, a dot, or a space). '
        + 'The server does not filter by the current prefix for you — read the labels.',
      schema: okSchema(
        {
          path: { type: 'string' },
          isIncomplete: { type: 'boolean' },
          items: {
            type: 'array',
            items: objectSchema(
              {
                label: { type: 'string' },
                kind: { type: 'integer' },
                detail: { type: 'string' },
                insertText: { type: 'string' },
              },
              ['label'],
            ),
          },
        },
        ['path', 'items'],
      ),
      async collect({ path, value }) {
        const items = Array.isArray(value?.items) ? value.items.slice(0, 40) : [];
        return {
          status: 'ok',
          path,
          isIncomplete: value?.isIncomplete === true,
          items: items.map((item) => ({
            label: String(item?.label ?? ''),
            kind: Number(item?.kind) || 0,
            detail: typeof item?.detail === 'string' ? item.detail : '',
            insertText: typeof item?.insertText === 'string' ? item.insertText : '',
          })),
        };
      },
      render(args, value) {
        if (value.status === 'error') return text(`${value.code}: ${value.message}`);
        if (value.items.length === 0) return text(`${value.path}:${args.line}:${args.character} 没有补全候选`);
        const lines = value.items.map(
          (item) => `${item.label}${item.detail === '' ? '' : `  ${clip(item.detail, 60)}`}`,
        );
        return text([`${value.items.length} 个候选：`, ...lines].join('\n'));
      },
    }),
  );

  const locationSchema = okSchema(
    { path: { type: 'string' }, locations: { type: 'array', items: objectSchema({ path: { type: 'string' }, line: { type: 'integer' }, character: { type: 'integer' } }, ['path', 'line', 'character']) } },
    ['path', 'locations'],
  );

  function locationRender(title) {
    return (args, value) => {
      if (value.status === 'error') return text(`${value.code}: ${value.message}`);
      if (value.locations.length === 0) return text(`${value.path}:${args.line}:${args.character} ${title}：没有结果`);
      const lines = value.locations.map((item) => `${item.path}:${item.line}:${item.character}`);
      return text(`${title}（${lines.length} 处）：\n${lines.join('\n')}`);
    };
  }

  /* ── definition ───────────────────────────────────────────────────────── */
  tools.push(
    positionTool({
      name: 'lean_definition',
      op: 'definition',
      description: 'Jump to the definition of the identifier at a position. Use `lean_hover` first if unsure what the term is.',
      schema: locationSchema,
      async collect({ path, value }) {
        return { status: 'ok', path, locations: locationsOf(value) };
      },
      render: locationRender('定义'),
    }),
  );

  /* ── references ───────────────────────────────────────────────────────── */
  tools.push(
    positionTool({
      name: 'lean_references',
      op: 'references',
      body: () => ({ includeDeclaration: true }),
      description: 'Find every use of the declaration at a position (declaration included).',
      schema: locationSchema,
      async collect({ path, value }) {
        return { status: 'ok', path, locations: locationsOf(value) };
      },
      render: locationRender('引用'),
    }),
  );

  /* ── code actions ─────────────────────────────────────────────────────── */
  tools.push(
    positionTool({
      name: 'lean_code_actions',
      op: 'codeActions',
      body: (args) => ({
        /* 整行作为查询区间：Lean 按行内诊断生成 `Try this` 之类的修复。 */
        range: {
          start: { line: Number(args.line) - 1, character: 0 },
          end: { line: Number(args.line), character: 0 },
        },
      }),
      description:
        'List the Lean code actions ("Try this" fixes) that apply to the line at a position. '
        + 'Each action carries the exact edits it would apply; applying them is the caller\'s job (edit the file, then re-run lean_diagnostics).',
      schema: okSchema(
        {
          path: { type: 'string' },
          actions: {
            type: 'array',
            items: objectSchema(
              {
                title: { type: 'string' },
                kind: { type: 'string' },
                preferred: { type: 'boolean' },
                edits: {
                  type: 'array',
                  items: objectSchema(
                    {
                      line: { type: 'integer' },
                      character: { type: 'integer' },
                      endLine: { type: 'integer' },
                      endCharacter: { type: 'integer' },
                      newText: { type: 'string' },
                    },
                    ['line', 'character', 'newText'],
                  ),
                },
              },
              ['title'],
            ),
          },
        },
        ['path', 'actions'],
      ),
      async collect({ path, value }) {
        const actions = Array.isArray(value?.actions) ? value.actions : [];
        return {
          status: 'ok',
          path,
          actions: actions.slice(0, 20).map((action) => {
            const changes = Array.isArray(action?.edit?.changes) ? action.edit.changes : [];
            return {
              title: String(action?.title ?? ''),
              kind: typeof action?.kind === 'string' ? action.kind : '',
              preferred: action?.isPreferred === true,
              edits: changes
                .filter((change) => change?.path === path || change?.path === undefined)
                .slice(0, 10)
                .map((change) => ({
                  line: Number(change?.range?.start?.line) + 1 || 1,
                  character: Number(change?.range?.start?.character) + 1 || 1,
                  endLine: Number(change?.range?.end?.line) + 1 || 1,
                  endCharacter: Number(change?.range?.end?.character) + 1 || 1,
                  newText: String(change?.newText ?? ''),
                })),
            };
          }),
        };
      },
      render(args, value) {
        if (value.status === 'error') return text(`${value.code}: ${value.message}`);
        if (value.actions.length === 0) {
          return text(`${value.path}:${args.line} 没有可用的代码动作（这一行没有可修复的诊断）`);
        }
        const blocks = value.actions.map((action) => {
          const head = `• ${action.title}${action.kind === '' ? '' : ` [${action.kind}]`}${action.preferred ? ' ★' : ''}`;
          const edits = action.edits.map(
            (edit) =>
              `    ${edit.line}:${edit.character}${edit.endLine === edit.line && edit.endCharacter === edit.character ? '' : `-${edit.endLine}:${edit.endCharacter}`} → ${clip(edit.newText, 120)}`,
          );
          return [head, ...edits].join('\n');
        });
        return text([`${value.actions.length} 个代码动作：`, ...blocks].join('\n'));
      },
    }),
  );

  /* ── outline ──────────────────────────────────────────────────────────── */
  tools.push({
    name: 'lean_outline',
    description: 'List the declarations in one file (namespaces, defs, theorems, structures…) with their line numbers.',
    parameters: objectSchema({ path: PATH_PROP }, ['path']),
    output: {
      schema: okSchema(
        {
          path: { type: 'string' },
          symbols: {
            type: 'array',
            items: objectSchema(
              {
                name: { type: 'string' },
                kind: { type: 'string' },
                container: { type: 'string' },
                line: { type: 'integer' },
              },
              ['name', 'line'],
            ),
          },
        },
        ['path', 'symbols'],
      ),
      render(_args, value) {
        if (value.status === 'error') return text(`${value.code}: ${value.message}`);
        if (value.symbols.length === 0) return text(`${value.path}：没有符号`);
        const lines = value.symbols.map((item) => {
          const qualified = item.container === '' ? item.name : `${item.container}.${item.name}`;
          return `L${item.line}  ${item.kind}  ${qualified}`;
        });
        return text([`${value.path} 的 ${value.symbols.length} 个声明：`, ...lines].join('\n'));
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const path = bridge.resolvePath(args.path);
      await bridge.prepare(path, { wait: false });
      const result = await run('documentSymbol', { op: 'documentSymbol', path });
      if (result.error !== undefined) return result.error;
      const symbols = Array.isArray(result.value?.symbols) ? result.value.symbols.slice(0, MAX_LISTED) : [];
      return {
        status: 'ok',
        path,
        symbols: symbols.map((item) => ({
          name: String(item?.name ?? ''),
          kind: symbolKindLabel(item?.kind),
          container: typeof item?.container === 'string' ? item.container : '',
          line: Number(item?.range?.start?.line) + 1 || Number(item?.selectionRange?.start?.line) + 1 || 1,
        })),
      };
    },
  });

  /* ── search ───────────────────────────────────────────────────────────── */
  tools.push({
    name: 'lean_search',
    description:
      'Search declarations across the whole Lean project by name. Pass `path` to pin the project; without it the tool '
      + 'anchors on any `.lean` file in the working directory.',
    parameters: objectSchema(
      {
        query: { type: 'string', description: 'Substring of the declaration name (case insensitive).' },
        path: { ...PATH_PROP, description: 'Optional anchor file that selects the Lean project.' },
        limit: { type: 'integer', description: 'Maximum results, default 20.' },
      },
      ['query'],
    ),
    output: {
      schema: okSchema(
        {
          query: { type: 'string' },
          symbols: {
            type: 'array',
            items: objectSchema(
              {
                name: { type: 'string' },
                kind: { type: 'string' },
                container: { type: 'string' },
                path: { type: 'string' },
                line: { type: 'integer' },
                character: { type: 'integer' },
              },
              ['name', 'path', 'line'],
            ),
          },
        },
        ['query', 'symbols'],
      ),
      render(_args, value) {
        if (value.status === 'error') return text(`${value.code}: ${value.message}`);
        if (value.symbols.length === 0) return text(`没有匹配 “${value.query}” 的声明`);
        const lines = value.symbols.map((item) => {
          const qualified = item.container === '' ? item.name : `${item.container}.${item.name}`;
          return `${item.path}:${item.line}:${item.character}  ${item.kind}  ${qualified}`;
        });
        return text([`“${value.query}” 命中 ${value.symbols.length} 个声明：`, ...lines].join('\n'));
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (typeof args.query !== 'string' || args.query.trim() === '') {
        return errorValue('invalid-args', '`query` must be a non-empty string');
      }
      let anchor;
      try {
        anchor = typeof args.path === 'string' && args.path.trim() !== '' ? bridge.resolvePath(args.path) : await bridge.anchor();
      } catch (error) {
        return errorValue('no-anchor', error instanceof Error ? error.message : String(error));
      }
      await bridge.prepare(anchor, { wait: false });
      const limit = Number.isFinite(Number(args.limit)) ? Math.min(Math.max(Number(args.limit), 1), 100) : 20;
      const result = await run('workspaceSymbol', { op: 'workspaceSymbol', path: anchor, query: args.query, limit });
      if (result.error !== undefined) return result.error;
      const symbols = Array.isArray(result.value?.symbols) ? result.value.symbols.slice(0, limit) : [];
      return {
        status: 'ok',
        query: args.query,
        symbols: symbols.map((item) => ({
          name: String(item?.name ?? ''),
          kind: symbolKindLabel(item?.kind),
          container: typeof item?.container === 'string' ? item.container : '',
          path: typeof item?.path === 'string' ? item.path : '',
          line: Number(item?.range?.start?.line) + 1 || 1,
          character: Number(item?.range?.start?.character) + 1 || 1,
        })),
      };
    },
  });

  return tools;
}
