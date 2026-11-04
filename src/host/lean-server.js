// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A small Lean 4 language-server client.
 *
 * Deliberately not a general LSP client: it speaks exactly the subset the
 * editor uses (document sync, diagnostics, hover, completion, definition,
 * plain goals, file progress). Everything else from `vscode-lean4` is either
 * VS Code-specific (webviews, commands, installers) or belongs to the RPC
 * layer the interactive info view would need.
 *
 * `spawn` is injected so the module can be tested against a fake child process
 * without touching a real toolchain.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { encodeMessage, createMessageReader } from './lsp-framing.js';

const INITIALIZE_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_BUFFER = 8_000;
/** `waitForIdle` 的默认静默窗口与轮询间隔。 */
const IDLE_QUIET_MS = 250;
const IDLE_POLL_MS = 60;

/** Language id Lean's server expects on `didOpen`. */
const LANGUAGE_ID = 'lean4';

function emptyListeners() {
  return { status: new Set(), diagnostics: new Set(), progress: new Set(), log: new Set() };
}

/**
 * @param {object} spec
 * @param {Function} spec.spawn        `node:child_process`.spawn (injected).
 * @param {string} spec.cwd            project root the server runs in.
 * @param {string} [spec.command]      server executable, default `lean`.
 * @param {string[]} [spec.args]       default `['--server']`.
 * @param {Function} [spec.log]        receives human-readable log lines.
 */
export function createLeanServer(spec) {
  const spawn = spec.spawn;
  const cwd = spec.cwd;
  const command = spec.command ?? 'lean';
  const args = spec.args ?? ['--server'];
  const log = spec.log ?? (() => {});

  const listeners = emptyListeners();
  const pending = new Map();
  const documents = new Map();
  const diagnostics = new Map();
  const progress = new Map();
  /** 每个 uri 最近一次收到诊断/进度的时刻，`waitForIdle` 靠它判断「还在算」。 */
  const activity = new Map();

  let child = null;
  let reader = null;
  let nextId = 1;
  let state = 'idle';
  let capabilities = null;
  let serverInfo = null;
  let stderrTail = '';
  let startedAt = 0;
  let disposed = false;
  /** 最近一次 dispose 的调用来源，用来解释「进程为什么没了」。 */
  let disposeReason = '';
  /** stdin 上第一次写失败的描述；非 null 之后不再往这条管道写。 */
  let stdinFailure = null;

  function emit(kind, payload) {
    for (const fn of listeners[kind]) {
      try {
        fn(payload);
      } catch (error) {
        log(`listener for ${kind} threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function setState(next, detail) {
    if (state === next) return;
    state = next;
    emit('status', { state: next, ...(detail === undefined ? {} : { detail }) });
  }

  function rejectAll(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  /**
   * 记录一次流错误，并保证它**不会**变成 uncaughtException。
   *
   * DSH 宿主把任何未捕获异常都当致命错误（`installFailLoud` → 写 stderr → exit(1)），
   * 于是 Lean 子进程退出后残留的一次 `write EPIPE` 就能把整个宿主连同所有会话打死，
   * 桌面端只看到「应用无法启动或已意外停止」。所以 stdin/stdout/stderr 都必须挂 error 监听：
   * 写失败记进日志和 `stderrTail`（`snapshot().stderr` 会带出去），再把等待中的请求拒掉。
   *
   * 读端（stdout/stderr）出错只记日志：子进程随后必有 `exit`，状态交给 `onChildExit`。
   *
   * @param which - 出错的流名，用于日志。
   * @param error - 流上报出来的错误。
   */
  function onStreamFailure(which, error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`[lean] ${which} error: ${detail}`);
    stderrTail = (stderrTail + `[lean] ${which} error: ${detail}\n`).slice(-STDERR_BUFFER);
    if (which !== 'stdin') return;
    if (stdinFailure === null) stdinFailure = detail;
    rejectAll(`could not write to the Lean server: ${detail}`);
    if (!disposed) setState('failed', detail);
  }

  function send(message) {
    const stream = child === null ? null : child.stdin;
    if (stream === null || stream === undefined || stream.destroyed || stdinFailure !== null) {
      const hint = stdinFailure === null ? '' : ` (${stdinFailure})`;
      throw new Error(`the Lean server is not running${hint}`);
    }
    try {
      stream.write(encodeMessage(message));
    } catch (error) {
      /* 流刚好被销毁时 write 会同步抛错：和异步 EPIPE 走同一条记账路径。 */
      onStreamFailure('stdin', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try {
        send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  /** Answer server→client requests; we declare almost no capabilities. */
  function answerServerRequest(message) {
    const method = message.method;
    let result = null;
    if (method === 'workspace/configuration') {
      const items = Array.isArray(message.params?.items) ? message.params.items : [];
      result = items.map(() => ({}));
    } else if (method === 'workspace/workspaceFolders') {
      result = [{ uri: pathToFileURL(cwd).href, name: cwd.split(/[\\/]/).pop() ?? 'workspace' }];
    } else if (method === 'client/registerCapability' || method === 'client/unregisterCapability') {
      result = null;
    } else if (method === 'window/workDoneProgress/create') {
      result = null;
    } else if (method === '$/lean/rpc/prepareHierarchy') {
      // 反向（server→client）的 hierarchy 请求我们不提供服务，明确拒绝而不是挂住。
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'prepareHierarchy is not supported by this client' },
      });
      return;
    } else if (method === 'window/showMessageRequest') {
      result = null;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  }

  function handleNotification(method, params) {
    if (method === 'textDocument/publishDiagnostics') {
      const uri = params?.uri;
      if (typeof uri !== 'string') return;
      const list = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      diagnostics.set(uri, list);
      progress.delete(uri);
      activity.set(uri, Date.now());
      emit('diagnostics', { uri, diagnostics: list });
      return;
    }
    if (method === '$/lean/fileProgress') {
      const uri = params?.textDocument?.uri;
      if (typeof uri !== 'string') return;
      const info = Array.isArray(params.processing) ? params.processing : [];
      progress.set(uri, info);
      activity.set(uri, Date.now());
      emit('progress', { uri, processing: info });
      return;
    }
    if (method === 'window/logMessage') {
      const text = params?.message;
      if (typeof text === 'string') log(`[lean] ${text}`);
      return;
    }
  }

  function handleMessage(message) {
    if (message === null || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    const hasMethod = typeof message.method === 'string';

    if (hasId && hasMethod) {
      answerServerRequest(message);
      return;
    }
    if (hasId && !hasMethod) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined && message.error !== null) {
        const detail = typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error);
        /*
         * 必须把 JSON-RPC 的错误码带出去：infoview 靠 `code === -32900`（rpcNeedsReconnect）
         * 判定「这个 RPC 会话已经废了」，然后丢掉它、下次重建。丢了码，它就会拿死会话
         * 一直重试，界面上就是永远消不掉的「Outdated RPC session. Try again.」。
         */
        const failure = new Error(detail);
        if (typeof message.error.code === 'number') failure.code = message.error.code;
        if (message.error.data !== undefined) failure.data = message.error.data;
        entry.reject(failure);
      } else {
        entry.resolve(message.result ?? null);
      }
      return;
    }
    if (hasMethod) handleNotification(message.method, message.params);
  }

  function onChildExit(code, signal) {
    const wasDisposed = disposed || state === 'stopped';
    const hint = disposeReason === '' ? '' : `（dispose: ${disposeReason}）`;
    /* 崩溃必须留下证据：桌面端没有控制台，宿主日志是唯一能事后看的地方。 */
    const tail = stderrTail.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' · ');
    log(`[lean] exited code=${code ?? 'null'} signal=${signal ?? 'none'}${hint}${tail === '' ? '' : ` stderr=${tail}`}`);
    rejectAll(`the Lean server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})${hint}`);
    if (wasDisposed) return;
    setState('failed', tail);
  }

  async function start() {
    if (state === 'ready') return capabilities;
    if (state === 'starting') throw new Error('the Lean server is already starting');
    if (disposed) throw new Error('this Lean server was disposed');

    setState('starting');
    startedAt = Date.now();
    stderrTail = '';
    stdinFailure = null;
    reader = createMessageReader(handleMessage, (warning) => log(`[lsp] ${warning}`));

    child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });
    /*
     * 三个流都必须有 error 监听，否则子进程一退，残留写入的 EPIPE 就会成为
     * uncaughtException，把 DSH 宿主整个打死（见 onStreamFailure 的注释）。
     */
    child.stdin?.on('error', (error) => onStreamFailure('stdin', error));
    child.stdout.on('error', (error) => onStreamFailure('stdout', error));
    child.stderr.on('error', (error) => onStreamFailure('stderr', error));
    child.stdout.on('data', (chunk) => reader.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_BUFFER);
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') log(`[lean stderr] ${line.trim()}`);
      }
    });
    child.on('error', (error) => {
      rejectAll(`could not start the Lean server: ${error.message}`);
      setState('failed', error.message);
    });
    child.on('exit', onChildExit);

    const result = await request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'dsh-lean4', version: '0.1.0' },
        rootUri: pathToFileURL(cwd).href,
        workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: 'workspace' }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
            definition: {},
            declaration: {},
            typeDefinition: {},
            references: {},
            documentHighlight: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            /* `kind` 是 Lean 私有的折叠种类：证明段给 'proof'，其余不填。
               不声明这一项时 Lean 根本不回 foldingRange。 */
            foldingRange: { lineFoldingOnly: true },
            /* `codeActionLiteralSupport` 让服务器回 CodeAction 对象（带 edit），
               而不是只能回 Command 字符串 —— "Try this: exact h" 就靠它。 */
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source'] },
              },
              isPreferredSupport: true,
              disabledSupport: false,
              dataSupport: false,
              resolveSupport: { properties: [] },
            },
            publishDiagnostics: { relatedInformation: true, versionSupport: false },
          },
          workspace: {
            workspaceFolders: true,
            configuration: true,
            symbol: { resolveSupport: { properties: [] } },
          },
          /* Lean 私有扩展：不声明这一项，服务器会把 isSilent 的消息（也就是
             `goalsAccomplished` 那条）整条过滤掉，行号栏就没有双对勾可画。
             见 Lean/Server/FileWorker.lean 的 `silentDiagnosticSupport` 分支。 */
          lean: { silentDiagnosticSupport: true },
        },
        initializationOptions: { hasWidgets: true, logCfg: 'none' },
      },
      INITIALIZE_TIMEOUT_MS,
    );

    capabilities = result?.capabilities ?? {};
    serverInfo = result?.serverInfo ?? null;
    notify('initialized', {});
    setState('ready', `started in ${Date.now() - startedAt}ms`);
    return capabilities;
  }

  function uriFor(path) {
    return pathToFileURL(path).href;
  }

  function fileFor(uri) {
    try {
      return fileURLToPath(uri);
    } catch {
      return undefined;
    }
  }

  async function openDocument(path, text) {
    await start();
    const uri = uriFor(path);
    const known = documents.get(uri);
    const version = (known?.version ?? 0) + 1;
    documents.set(uri, { path, version, text });
    if (known === undefined) {
      notify('textDocument/didOpen', {
        textDocument: { uri, languageId: LANGUAGE_ID, version, text },
      });
    } else {
      notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    return { uri, version };
  }

  async function changeDocument(path, text) {
    const uri = uriFor(path);
    const known = documents.get(uri);
    if (known === undefined) return openDocument(path, text);
    const version = known.version + 1;
    documents.set(uri, { path, version, text });
    notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    return { uri, version };
  }

  function closeDocument(path) {
    const uri = uriFor(path);
    if (!documents.has(uri)) return false;
    documents.delete(uri);
    diagnostics.delete(uri);
    progress.delete(uri);
    activity.delete(uri);
    if (state === 'ready') notify('textDocument/didClose', { textDocument: { uri } });
    return true;
  }

  function textDocumentPosition(path, position) {
    return {
      textDocument: { uri: uriFor(path) },
      position: { line: position.line, character: position.character },
    };
  }

  function markdownOf(contents) {
    if (contents === null || contents === undefined) return '';
    if (typeof contents === 'string') return contents;
    if (Array.isArray(contents)) {
      return contents
        .map((part) => (typeof part === 'string' ? part : typeof part?.value === 'string' ? part.value : ''))
        .filter((part) => part !== '')
        .join('\n\n');
    }
    if (typeof contents.value === 'string') return contents.value;
    return '';
  }

  async function hover(path, position) {
    await start();
    const result = await request('textDocument/hover', textDocumentPosition(path, position));
    if (result === null || result === undefined) return null;
    const text = markdownOf(result.contents).trim();
    if (text === '') return null;
    return { text, range: result.range ?? null };
  }

  /**
   * `Location` / `LocationLink` / `null` 三种返回形状统一成数组。
   *
   * 服务器对 definition 家族（definition/declaration/typeDefinition/references）
   * 的返回形状是同一个联合类型，所以只写一次。
   */
  function toLocations(result) {
    if (result === null || result === undefined) return [];
    const locations = Array.isArray(result) ? result : [result];
    return locations
      .filter((location) => location !== null && typeof location === 'object' && typeof location.uri === 'string')
      .map((location) => ({
        path: fileFor(location.uri),
        uri: location.uri,
        range: location.range ?? location.targetSelectionRange ?? null,
      }))
      .filter((location) => location.range !== null);
  }

  async function definition(path, position) {
    await start();
    return toLocations(await request('textDocument/definition', textDocumentPosition(path, position)));
  }

  async function declaration(path, position) {
    await start();
    return toLocations(await request('textDocument/declaration', textDocumentPosition(path, position)));
  }

  async function typeDefinition(path, position) {
    await start();
    return toLocations(await request('textDocument/typeDefinition', textDocumentPosition(path, position)));
  }

  async function references(path, position, includeDeclaration = true) {
    await start();
    return toLocations(
      await request('textDocument/references', {
        ...textDocumentPosition(path, position),
        context: { includeDeclaration: includeDeclaration !== false },
      }),
    );
  }

  async function documentHighlight(path, position) {
    await start();
    const result = await request('textDocument/documentHighlight', textDocumentPosition(path, position));
    if (!Array.isArray(result)) return [];
    return result
      .filter((item) => item !== null && typeof item === 'object' && item.range !== undefined)
      .map((item) => ({ range: item.range, kind: typeof item.kind === 'number' ? item.kind : 1 }));
  }

  /**
   * `kind: 'proof'` 的折叠段就是定理证明体。
   *
   * 上游 `vscode-lean4/src/utils/converters.ts:148-153` 用同一个判据
   * （`proofFoldingRangeKind = 'proof'`）把 range 标成 `isProof`，这里照抄，
   * 让「只折叠证明」这类命令不必再猜。
   */
  async function foldingRanges(path) {
    await start();
    const result = await request('textDocument/foldingRange', { textDocument: { uri: uriFor(path) } });
    if (!Array.isArray(result)) return [];
    return result
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => {
        const startLine = Number(item.startLine);
        const endLine = Number(item.endLine ?? item.startLine);
        const kind = typeof item.kind === 'string' ? item.kind : '';
        return { startLine, endLine, kind, isProof: kind === 'proof' };
      })
      .filter((item) => Number.isInteger(item.startLine) && Number.isInteger(item.endLine) && item.endLine > item.startLine);
  }

  /**
   * `textDocument/codeAction`。
   *
   * `context.diagnostics` 必须把**与该区间相交的诊断**原样传回去：Lean 是靠诊断里的
   * `code` / `source` 才决定生成哪条 action 的（"Try this: exact h" 就是诊断的镜像），
   * 传空数组会得到空结果。
   */
  /**
   * 把 `WorkspaceEdit` 摊平成 `{ changes: [{ uri, path, range, newText }] }`。
   *
   * Lean 发的是 `documentChanges`（`TextDocumentEdit[]`）形状，而老式客户端协议是
   * `changes`（`{ uri: TextEdit[] }`）。上层（建议面板、Agent 工具）只关心
   * 「改哪个文件、哪一段、换成什么」，所以这里一次摊平，别让它俩各写一遍。
   * 文件重命名/创建/删除 Lean 不发，遇到就跳过而不是报错。
   */
  function toWorkspaceEdit(edit) {
    if (edit === null || typeof edit !== 'object') return null;
    const out = [];
    const push = (uri, item) => {
      if (typeof uri !== 'string' || item === null || typeof item !== 'object') return;
      if (typeof item.newText !== 'string' || item.range === undefined) return;
      out.push({ uri, path: fileFor(uri), range: item.range, newText: item.newText });
    };
    if (edit.changes !== null && typeof edit.changes === 'object') {
      for (const [uri, list] of Object.entries(edit.changes)) {
        if (Array.isArray(list)) for (const item of list) push(uri, item);
      }
    }
    if (Array.isArray(edit.documentChanges)) {
      for (const entry of edit.documentChanges) {
        if (!Array.isArray(entry?.edits)) continue;
        for (const item of entry.edits) push(entry?.textDocument?.uri, item);
      }
    }
    return out.length > 0 ? { changes: out } : null;
  }

  async function codeActions(path, range, diagnostics = [], only) {
    await start();
    const uri = uriFor(path);
    const context = { diagnostics: Array.isArray(diagnostics) ? diagnostics : [] };
    if (Array.isArray(only) && only.length > 0) context.only = only;
    const result = await request('textDocument/codeAction', {
      textDocument: { uri },
      range,
      context,
    });
    if (!Array.isArray(result)) return [];
    return result
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title : '',
        kind: typeof item.kind === 'string' ? item.kind : '',
        isPreferred: item.isPreferred === true,
        edit: toWorkspaceEdit(item.edit),
        command: typeof item.command?.command === 'string' ? item.command : null,
      }))
      .filter((item) => item.title !== '');
  }

  /** 文件内符号（`documentSymbol`；扁平 `SymbolInformation[]` 与嵌套两种形状都吃）。 */
  async function documentSymbols(path) {
    await start();
    const result = await request('textDocument/documentSymbol', { textDocument: { uri: uriFor(path) } });
    if (!Array.isArray(result)) return [];
    const out = [];
    const walk = (items, container) => {
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        const name = typeof item.name === 'string' ? item.name : '';
        const range = item.range ?? item.location?.range;
        if (name !== '' && range !== undefined) {
          out.push({
            name,
            kind: typeof item.kind === 'number' ? item.kind : 0,
            container: container === '' ? '' : container,
            range,
            selectionRange: item.selectionRange ?? range,
          });
        }
        if (Array.isArray(item.children)) walk(item.children, container === '' ? name : `${container}.${name}`);
      }
    };
    walk(result, '');
    return out;
  }

  /** 全项目按名查符号（`workspace/symbol`）。 */
  async function workspaceSymbols(query, limit = 50) {
    await start();
    const result = await request('workspace/symbol', { query: String(query ?? '') });
    if (!Array.isArray(result)) return [];
    return result
      .filter((item) => item !== null && typeof item === 'object' && typeof item.name === 'string')
      .slice(0, Math.max(1, limit))
      .map((item) => ({
        name: item.name,
        kind: typeof item.kind === 'number' ? item.kind : 0,
        container: typeof item.containerName === 'string' ? item.containerName : '',
        path: typeof item.location?.uri === 'string' ? fileFor(item.location.uri) : undefined,
        uri: typeof item.location?.uri === 'string' ? item.location.uri : '',
        range: item.location?.range ?? null,
      }));
  }

  /** 已打开的文档（诊断/折叠工具的「这份文本是谁的」判定要用）。 */
  function isOpen(path) {
    return documents.has(uriFor(path));
  }

  function textOf(path) {
    return documents.get(uriFor(path))?.text;
  }

  function diagnosticsOf(path) {
    return diagnostics.get(uriFor(path)) ?? [];
  }

  function progressOf(path) {
    return progress.get(uriFor(path)) ?? [];
  }

  /** 最近一次收到该文件诊断/进度的时刻（毫秒），从未有过就是 0。 */
  function lastActivityAt(path) {
    return activity.get(uriFor(path)) ?? 0;
  }

  /** 还在算：Lean 的 `$/lean/fileProgress` 里 `kind === 0` 表示 processing。 */
  function busyAt(path) {
    return progressOf(path).some((item) => item?.kind === 0);
  }

  /**
   * 等 Lean 把这次 didOpen/didChange 精化完。
   *
   * 没有这个原语时，刚 `openDocument()` 就 `diagnosticsOf()` 会读到上一版——
   * `publishDiagnostics` 是异步推过来的，甚至可能先推一条空数组。判据是
   * 「最近一次活动早于 now-quietMs 且没有 processing」，`since` 由调用方在
   * open/change **之前**取，避免「文件刚打开、一个事件都还没来」时立刻返回旧值。
   *
   * @returns `{ settled, waitedMs }`；超时不抛错，交给调用方决定怎么表述。
   */
  async function waitForIdle(path, options = {}) {
    const since = typeof options.since === 'number' ? options.since : 0;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 5_000;
    const quietMs = typeof options.quietMs === 'number' ? options.quietMs : IDLE_QUIET_MS;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const now = Date.now();
      const last = Math.max(lastActivityAt(path), since);
      if (last > 0 && now - last >= quietMs && !busyAt(path)) {
        return { settled: true, waitedMs: now - since };
      }
      if (now >= deadline) return { settled: false, waitedMs: now - since };
      const step = Math.min(IDLE_POLL_MS, Math.max(1, deadline - now));
      await new Promise((resolve) => setTimeout(resolve, step));
    }
  }

  async function completion(path, position) {
    await start();
    const result = await request('textDocument/completion', textDocumentPosition(path, position));
    if (result === null || result === undefined) return { items: [] };
    const items = Array.isArray(result) ? result : Array.isArray(result.items) ? result.items : [];
    return {
      isIncomplete: Array.isArray(result) ? false : result.isIncomplete === true,
      items: items
        .filter((item) => item !== null && typeof item === 'object')
        .map((item) => ({
          label: typeof item.label === 'string' ? item.label : '',
          kind: typeof item.kind === 'number' ? item.kind : 0,
          detail: typeof item.detail === 'string' ? item.detail : '',
          documentation: markdownOf(item.documentation),
          insertText: typeof item.insertText === 'string' ? item.insertText : '',
          sortText: typeof item.sortText === 'string' ? item.sortText : '',
        }))
        .filter((item) => item.label !== ''),
    };
  }

  async function plainGoal(path, position) {
    await start();
    const result = await request('$/lean/plainGoal', textDocumentPosition(path, position));
    if (result === null || result === undefined) return null;
    return {
      rendered: typeof result.rendered === 'string' ? result.rendered : '',
      goals: Array.isArray(result.goals) ? result.goals.filter((goal) => typeof goal === 'string') : [],
    };
  }

  async function plainTermGoal(path, position) {
    await start();
    const result = await request('$/lean/plainTermGoal', textDocumentPosition(path, position));
    if (result === null || result === undefined) return null;
    return {
      goal: typeof result.goal === 'string' ? result.goal : '',
      range: result.range ?? null,
    };
  }

  function snapshot(path) {
    const uri = path === undefined ? undefined : uriFor(path);
    return {
      state,
      capabilities,
      serverInfo,
      cwd,
      startedAt,
      stderr: stderrTail.split('\n').filter((line) => line.trim() !== '').slice(-8),
      documents: [...documents.values()].map((doc) => ({ path: doc.path, version: doc.version })),
      diagnostics:
        uri === undefined
          ? [...diagnostics.entries()].map(([key, list]) => ({ uri: key, diagnostics: list }))
          : [{ uri, diagnostics: diagnostics.get(uri) ?? [] }],
      progress: uri === undefined ? [] : [{ uri, processing: progress.get(uri) ?? [] }],
    };
  }

  async function restart() {
    dispose('restart');
    disposed = false;
    stdinFailure = null;
    state = 'idle';
    return start();
  }

  /**
   * 停掉服务器。
   *
   * `reason` 会被记进 `disposeReason` 并随状态事件发给浏览器：进程被 SIGTERM 时
   * 光看「the Lean server exited」判断不了是谁杀的，必须知道是哪条路径调用的。
   */
  function dispose(reason = 'unknown') {
    disposeReason = reason;
    disposed = true;
    log(`[lean] dispose (${reason})`);
    if (child !== null) {
      try {
        if (state === 'ready') {
          send({ jsonrpc: '2.0', id: nextId++, method: 'shutdown', params: null });
          send({ jsonrpc: '2.0', method: 'exit', params: null });
        }
      } catch {
        // The pipe is already gone; the kill below is the real cleanup.
      }
      try {
        child.kill();
      } catch {
        // Already dead.
      }
      child = null;
    }
    rejectAll('the Lean server was disposed');
    documents.clear();
    diagnostics.clear();
    progress.clear();
    activity.clear();
    setState('stopped');
  }

  return {
    get state() {
      return state;
    },
    get capabilities() {
      return capabilities;
    },
    get serverInfo() {
      return serverInfo;
    },
    get cwd() {
      return cwd;
    },
    get disposeReason() {
      return disposeReason;
    },
    start,
    openDocument,
    changeDocument,
    closeDocument,
    hover,
    completion,
    definition,
    declaration,
    typeDefinition,
    references,
    documentHighlight,
    documentSymbols,
    workspaceSymbols,
    foldingRanges,
    codeActions,
    isOpen,
    textOf,
    diagnosticsOf,
    progressOf,
    lastActivityAt,
    busyAt,
    waitForIdle,
    plainGoal,
    plainTermGoal,
    /** 原样转发任意 LSP 请求（infoview 的 `$/lean/rpc/*` 全靠这一条）。 */
    request: (method, params, timeoutMs) => request(method, params, timeoutMs),
    /** 原样转发任意 LSP 通知（`$/lean/rpc/release`、`$/lean/rpc/keepAlive`）。 */
    notify: (method, params) => notify(method, params),
    snapshot,
    restart,
    dispose,
    on(kind, handler) {
      if (!(kind in listeners)) throw new Error(`unknown event "${kind}"`);
      listeners[kind].add(handler);
      return () => listeners[kind].delete(handler);
    },
  };
}
