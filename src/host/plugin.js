// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The host half of `dsh-lean4`: it owns the `lean --server` processes and
 * exposes them to the browser half over two routes.
 *
 *   POST /lean-lsp/api     one JSON request per call (open/change/hover/goals/…)
 *   GET  /lean-lsp/events  server-sent events: diagnostics, file progress, state
 *
 * No npm dependencies: only `node:` builtins. That is deliberate — this package
 * is installed with `link:`, so a bare import would have to resolve out of the
 * plugin's own checkout and would recreate the 2026-10-26 boot failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createLeanServer } from './lean-server.js';
import { createLeanTools } from './tools.js';
import { hostLog } from './hostlog.js';
import { resolveLeanBinary } from './lean-binary.js';

/** Plugin identity for the injected cordis row. */
const name = 'dsh-lean4';

/** Services that must exist before `apply` runs. */
const inject = ['webServer', 'connection'];

/** Files that mark a Lean project root. */
const ROOT_MARKERS = ['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json'];

/** How many project roots keep a live server at once. */
const MAX_SERVERS = 3;

/** SSE heartbeat so proxies and the browser do not drop an idle stream. */
const HEARTBEAT_MS = 15_000;

/**
 * Walk up from a file's directory looking for a Lean project marker.
 * Falls back to the file's own directory, which is what `lean --server` wants
 * for a standalone file.
 */
function projectRootOf(path) {
  let dir = dirname(resolve(path));
  const start = dir;
  for (let depth = 0; depth < 12; depth += 1) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
  });
  res.end(body);
}

/** Collect a request body with a hard size cap. */
async function readJsonBody(req, limit = 8 * 1024 * 1024) {
  if (req.method !== 'POST') return { ok: false, message: 'this route only accepts POST' };
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return { ok: false, message: 'request body is too large' };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { ok: false, message: 'request body is empty' };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return { ok: false, message: 'request body must be an object' };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, message: `request body is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function positionOf(body) {
  const line = Number(body.line);
  const character = Number(body.character);
  if (!Number.isFinite(line) || !Number.isFinite(character) || line < 0 || character < 0) return undefined;
  return { line, character };
}

function stringOf(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** Shape one diagnostic for the browser half (0-based line/character). */
function wireDiagnostic(item) {
  const range = item?.range ?? {};
  const start = range.start ?? {};
  const end = range.end ?? {};
  return {
    severity: typeof item?.severity === 'number' ? item.severity : 1,
    message: stringOf(item?.message),
    code: typeof item?.code === 'string' || typeof item?.code === 'number' ? String(item.code) : '',
    source: stringOf(item?.source, 'lean'),
    startLine: Number(start.line) || 0,
    startCharacter: Number(start.character) || 0,
    endLine: Number(end.line) || 0,
    endCharacter: Number(end.character) || 0,
    tags: Array.isArray(item?.tags) ? item.tags.filter((tag) => typeof tag === 'number') : [],
    /* Lean 的私有扩展：`leanTags: [2]` = 目标已全部解决（信息级，不进问题列表），
     * 编辑器靠它在行号栏画 ✓✓，别在宿主半丢掉。 */
    leanTags: Array.isArray(item?.leanTags) ? item.leanTags.filter((tag) => typeof tag === 'number') : [],
    isSilent: item?.isSilent === true,
  };
}

/** 同一个 ctx 上只允许装一次：重复 apply 会重复注册路由、重复拉起 lean 进程。
 *  注意必须是 Symbol——cordis 的 ctx 代理对普通字符串属性赋值会抛
 *  `cannot set property "x" without provide`，Symbol 才会落到 Reflect.set。 */
const APPLIED = Symbol.for('dsh-lean4.applied');

/* 模块被 import 就落一行，用来区分「没加载」和「加载了但 apply 没跑」。 */
hostLog('module: loaded');

export function apply(ctx, config) {
  hostLog('apply: enter');
  try {
    return applyInner(ctx, config);
  } catch (error) {
    hostLog(`apply: THREW ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    throw error;
  }
}

function applyInner(ctx, config) {
  hostLog(`apply: ctx.webServer=${typeof ctx.webServer} ctx.connection=${typeof ctx.connection}`);
  /* 标记必须挂在根 ctx 上：cordis 给每个插件一个**子** ctx，Symbol 不会被继承，
     挂在子 ctx 上等于每次 apply 都是新标记，重复注册照样发生。 */
  const root = ctx.root ?? ctx;
  if (root[APPLIED] === true) {
    ctx.logger?.warn?.('[lean] 宿主半被重复 apply，本次调用跳过');
    hostLog('apply: skipped (already applied on this ctx)');
    return;
  }
  root[APPLIED] = true;
  /* 不要读 `ctx.baseDir`：没声明在 `inject` 里访问它会抛，apply 静默失败、路由一条都注册不上。
     需要目录就用 `process.cwd()`。 */
  const cwd = typeof process.cwd === 'function' ? process.cwd() : 'unknown';
  ctx.logger?.info?.(`[lean] 宿主半已加载（cwd=${cwd}）`);
  hostLog(`apply: mark applied, cwd=${cwd}`);

  const options = config ?? {};
  /* 显式配置的 command 优先；没配就自己找 toolchain 里的真二进制。
     PATH 上的 `lean` 是 elan 的分发壳，会联网查 release，离线时能卡到分钟级。 */
  const explicitCommand = typeof options.command === 'string' && options.command.trim() !== '' ? options.command : null;
  const serverArgs = Array.isArray(options.args) ? options.args.filter((arg) => typeof arg === 'string') : ['--server'];
  const enabled = options.enabled !== false;

  /** root → { server, lastUsed } */
  const pool = new Map();
  /** 被浏览器 didOpen 过的路径：这些文档的内容以浏览器为准，磁盘可能更旧。 */
  const browserOwned = new Set();
  /*
   * 连续失败的保护：路径拼错时 spawn 的 cwd 不存在、子进程根本没起来，而浏览器
   * 每 4 秒一次的 pull 又会重建一次，形成「起不来—重建—再起不来」的雪崩。
   * 这里做指数退避 + 熔断：
   * 同一个 root 连续失败 6 次后不再自动重建，必须点「重启」或重新打开文件。
   */
  const FAIL_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
  const MAX_STRIKES = 6;
  /** root → { strikes, retryAfter, message } */
  const failures = new Map();
  /** SSE subscribers */
  const subscribers = new Set();
  let heartbeat = null;

  if (!enabled) {
    ctx.logger?.info?.('lean LSP bridge disabled by config');
    return;
  }

  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(frame);
      } catch {
        subscribers.delete(res);
      }
    }
  }

  function evictIfNeeded() {
    if (pool.size <= MAX_SERVERS) return;
    const entries = [...pool.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    while (pool.size > MAX_SERVERS && entries.length > 0) {
      const [root, entry] = entries.shift();
      if (pool.get(root) !== entry) continue;
      try {
        entry.server.dispose('evict');
      } catch {
        // Disposal is best effort.
      }
      pool.delete(root);
    }
  }

  /** 每个根只解析一次二进制路径（解析本身只读几个小文件，仍然缓存起来）。 */
  const binaryCache = new Map();
  function resolveCommand(root) {
    const cached = binaryCache.get(root);
    if (cached !== undefined) return cached;
    const startedAt = Date.now();
    const resolved = resolveLeanBinary(
      { root },
      {
        join,
        dirname,
        basename,
        platform: process.platform,
        env: process.env,
        exists: existsSync,
        readFile: (file) => readFileSync(file, 'utf8'),
        listDir: (dir) => readdirSync(dir),
      },
    );
    hostLog(`resolve: ${resolved.command}（${resolved.source}）${Date.now() - startedAt}ms`);
    binaryCache.set(root, resolved);
    return resolved;
  }

  function isDirectory(target) {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  /** 记一次启动/运行失败，给出下一次允许重建的时间。 */
  function noteFailure(root, message) {
    const previous = failures.get(root) ?? { strikes: 0, retryAfter: 0, message: '' };
    const strikes = previous.strikes + 1;
    const wait = FAIL_BACKOFF_MS[Math.min(strikes - 1, FAIL_BACKOFF_MS.length - 1)];
    failures.set(root, { strikes, retryAfter: Date.now() + wait, message });
    hostLog(`serverFor: 第 ${strikes} 次失败 (root=${root})：${message}；${wait}ms 后允许重建`);
  }

  /**
   * 现在能不能重建：返回一句人话（不能），或 null（可以）。
   *
   * @param {string} root
   * @returns {string | null}
   */
  function failureBlock(root) {
    const entry = failures.get(root);
    if (entry === undefined) return null;
    if (entry.strikes >= MAX_STRIKES) {
      return (
        `${entry.message}（连续 ${entry.strikes} 次失败，已停止自动重启；` +
        '修好问题后点状态栏的「重启」或重新打开文件）'
      );
    }
    const remaining = entry.retryAfter - Date.now();
    if (remaining <= 0) return null;
    return `${entry.message}（${Math.ceil(remaining / 1000)} 秒后自动重试）`;
  }

  function serverFor(path, callOptions = {}) {
    const root = projectRootOf(path);
    /* 根目录必须真的存在：`spawn` 的 cwd 不存在时 Node 只会发一个 ENOENT 错误事件，
       子进程压根没起来，而界面上看起来就是「Lean 一直崩溃」。 */
    if (!isDirectory(root)) {
      throw new Error(
        `Lean 工程的根目录不存在：${root}（文件 ${path}）。` +
          '通常是文件路径是相对路径、而宿主半拿它拼了 process.cwd()；请从文件树重新打开该文件。',
      );
    }
    if (callOptions.force === true) {
      failures.delete(root);
    } else {
      const blocked = failureBlock(root);
      if (blocked !== null) throw new Error(blocked);
    }
    const existing = pool.get(root);
    if (existing !== undefined) {
      if (existing.server.state === 'failed' || existing.server.state === 'stopped') {
        /* 进程已经没了（崩溃、被外面杀掉、被 dispose）：删掉条目重建，
           否则这个根会永远停在「未连接」，用户只能重启应用。 */
        hostLog(`serverFor: pool entry in state "${existing.server.state}", recreating (root=${root})`);
        try {
          existing.server.dispose('recreate-after-exit');
        } catch {
          // 已经在收拾了。
        }
        pool.delete(root);
      } else {
        existing.lastUsed = Date.now();
        return { root, server: existing.server };
      }
    }
    const resolved = explicitCommand === null ? resolveCommand(root) : { command: explicitCommand, source: 'config.command' };
    const command = resolved.command;
    hostLog(`serverFor: spawning "${command} ${serverArgs.join(' ')}" in ${root} (binary from ${resolved.source})`);
    const server = createLeanServer({
      spawn,
      cwd: root,
      command,
      args: serverArgs,
      log: (line) => {
        ctx.logger?.debug?.(line);
        hostLog(`lean: ${line}`);
      },
    });
    server.on('status', (status) => {
      if (status.state === 'failed') noteFailure(root, String(status.message ?? 'unknown failure'));
      else if (status.state === 'ready') failures.delete(root);
      broadcast({ type: 'status', root, ...status });
    });
    server.on('diagnostics', ({ uri, diagnostics }) =>
      broadcast({ type: 'diagnostics', root, uri, diagnostics: diagnostics.map(wireDiagnostic) }),
    );
    server.on('progress', ({ uri, processing }) =>
      broadcast({
        type: 'progress',
        root,
        uri,
        processing: processing.map((item) => ({
          startLine: Number(item?.range?.start?.line) || 0,
          endLine: Number(item?.range?.end?.line) || 0,
          kind: Number(item?.kind) || 0,
        })),
      }),
    );
    pool.set(root, { server, lastUsed: Date.now() });
    evictIfNeeded();
    return { root, server };
  }

  /**
   * 让服务器持有某个文件的最新内容，供**非浏览器**调用方（Agent 工具）使用。
   *
   * 两条内容来源的优先级很重要：
   *   - 浏览器打开过该文件 → 以浏览器文本为准（用户可能还没保存），并在 notes 里说明；
   *   - 否则读磁盘，内容与服务器持有的不同才发 didChange（省掉无意义的重新精化）。
   *
   * 读到不存在的文件时抛错，由调用方转成工具的错误结果。
   */
  async function ensureDocument(path) {
    const { root, server } = serverFor(path);
    const notes = [];
    if (browserOwned.has(path) && server.isOpen(path)) {
      notes.push('该文件正在编辑器中打开，结果基于编辑器里的内容（可能尚未保存）');
      return { root, server, notes, text: server.textOf(path) ?? '' };
    }
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(`读取失败：${path}（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (!server.isOpen(path)) {
      await server.openDocument(path, text);
    } else if (server.textOf(path) !== text) {
      await server.changeDocument(path, text);
    }
    return { root, server, notes, text };
  }

  /* ── Agent 工具的垫层 ──────────────────────────────────────────────────── */

  /** 工具参数里的路径：空值报错，相对路径按 DSH 的工作目录解析。 */
  function resolveToolPath(raw) {
    const text = stringOf(raw);
    if (text === '') throw new Error('path 不能为空');
    return resolve(process.cwd(), text);
  }

  const ANCHOR_MAX_DIRS = 200;
  const ANCHOR_MAX_DEPTH = 3;

  /**
   * `lean_search` 可以不带 path，但 `workspace/symbol` 需要一个项目锚点。
   * 从工作目录往下找一个 `.lean` 文件当锚点（跳过隐藏目录与 node_modules）。
   */
  function findLeanFile(dir, depth, budget) {
    if (depth > ANCHOR_MAX_DEPTH || budget.left <= 0) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    budget.left -= 1;
    const files = [];
    const directories = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isFile() && entry.name.endsWith('.lean')) files.push(entry.name);
      else if (entry.isDirectory()) directories.push(entry.name);
    }
    files.sort();
    if (files.length > 0) return join(dir, files[0]);
    directories.sort();
    for (const name of directories) {
      const found = findLeanFile(join(dir, name), depth + 1, budget);
      if (found !== null) return found;
    }
    return null;
  }

  function toolAnchor() {
    const found = findLeanFile(process.cwd(), 0, { left: ANCHOR_MAX_DIRS });
    if (found === null) throw new Error('工作目录下找不到 .lean 文件，请用 path 指定项目里的一个文件');
    return found;
  }

  /**
   * 让服务器持有最新内容，按需等这次精化结束。
   *
   * `wait: false` 用于 hover/definition 这类「立刻要答案」的请求；诊断与代码动作
   * 必须等，否则读到的是上一版（`publishDiagnostics` 是异步推过来的）。
   */
  async function prepareForTool(path, options = {}) {
    const since = Date.now();
    const { server, notes } = await ensureDocument(path);
    if (options.wait === false) return { settled: true, waitedMs: 0, notes };
    const requested = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requested) ? Math.max(0, requested) : 10_000;
    const idle = await server.waitForIdle(path, { since, timeoutMs });
    return { settled: idle.settled, waitedMs: idle.waitedMs, notes };
  }

  /**
   * 注册 Lean 的 Agent 工具。
   *
   * 为什么不让 agent 直接打 HTTP：`/lean-lsp/api` 由 `admitted()` 把关，只有带浏览器
   * 会话的请求才放行，宿主进程里的 `fetch` 一律 403。工具在进程内直接调 `handle()`，
   * 没有 HTTP、没有鉴权，也不需要冒用谁的登录态。
   *
   * `tools` 不写进静态 `inject`：服务缺席时 LSP 桥（浏览器那半）仍然要能用。
   */
  function registerAgentTools(scoped) {
    /*
     * 必须用 inject 回调给的 `scoped`：`tools` 不在本插件的静态 inject 里，
     * 直接读外层的 `ctx.tools` 会被 cordis 判成「without inject」而抛错
     * （0.8.0 就是这么静默失败的：九个工具一个都没注册上）。
     */
    const registry = scoped.tools;
    const tools = createLeanTools({
      resolvePath: resolveToolPath,
      anchor: async () => toolAnchor(),
      prepare: prepareForTool,
      run: (op, body) => handle(body),
    });
    let registered = 0;
    for (const definition of tools) {
      const disposer = registry.register(definition);
      if (typeof scoped.effect === 'function' && typeof disposer === 'function') {
        scoped.effect(() => disposer);
      }
      registered += 1;
    }
    hostLog(`apply: agent tools registered (${registered})`);
    ctx.logger?.info?.(`[lean] 已注册 ${registered} 个 Agent 工具`);
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (scoped) => {
        try {
          registerAgentTools(scoped);
        } catch (error) {
          hostLog(`tools: 注册失败 ${error instanceof Error ? error.message : String(error)}`);
          ctx.logger?.warn?.(`[lean] Agent 工具注册失败：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    } catch (error) {
      hostLog(`tools: inject 挂不上 ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handle(body) {
    const op = stringOf(body.op);
    const path = stringOf(body.path);
    if (path === '') return { ok: false, error: { code: 'bad-request', message: 'path is required' } };
    /*
     * 只认绝对路径、而且文件得真的在。以前这里什么都不查，于是相对路径
     * （`施工方案/PlanSpec.lean`）会被拼成 profile 目录下的鬼路径，
     * `lean --server` 的 cwd 不存在、子进程根本起不来，界面只看到「一直崩溃」。
     * 明确报错比让进程静默失败好排查得多。
     */
    if (op !== 'close' && op !== 'stop' && !existsSync(path)) {
      return {
        ok: false,
        error: {
          code: 'unknown-file',
          message: `找不到文件：${path}（相对路径必须先转成绝对路径；宿主半只认绝对路径）`,
        },
      };
    }

    if (op === 'pull') {
      const { root, server } = serverFor(path);
      const snapshot = server.snapshot(path);
      return {
        ok: true,
        value: {
          root,
          state: snapshot.state,
          /* infoview 靠这两个字段判断「服务器起来了没」以及某些特性可用性。 */
          capabilities: snapshot.capabilities,
          serverInfo: snapshot.serverInfo,
          diagnostics: snapshot.diagnostics[0]?.diagnostics.map(wireDiagnostic) ?? [],
          progress: snapshot.progress[0]?.processing.map((item) => ({
            startLine: Number(item?.range?.start?.line) || 0,
            endLine: Number(item?.range?.end?.line) || 0,
            kind: Number(item?.kind) || 0,
          })) ?? [],
          stderr: snapshot.stderr,
        },
      };
    }

    if (op === 'restart') {
      /* 「重启」是用户手动解除熔断的开关：清掉失败计数、丢掉旧条目、强制重建。 */
      const forced = serverFor(path, { force: true });
      await forced.server.restart();
      return { ok: true, value: { root: forced.root } };
    }

    const { root, server } = serverFor(path);

    if (op === 'stop') {
      failures.delete(root);
      server.dispose('stop-op');
      pool.delete(root);
      return { ok: true, value: { root } };
    }
    if (op === 'close') {
      browserOwned.delete(path);
      server.closeDocument(path);
      return { ok: true, value: { root } };
    }
    if (op === 'open') {
      const text = stringOf(body.text);
      const opened = await server.openDocument(path, text);
      browserOwned.add(path);
      return { ok: true, value: { root, version: opened.version } };
    }
    if (op === 'change') {
      const text = stringOf(body.text);
      const changed = await server.changeDocument(path, text);
      browserOwned.add(path);
      return { ok: true, value: { root, version: changed.version } };
    }

    /* infoview 需要原始 LSP 通道：`$/lean/rpc/connect`、`$/lean/rpc/call` 都是
       client→server 的普通请求，转发即可，不需要在宿主半理解 RPC 语义。 */
    if (op === 'request') {
      const method = stringOf(body.method);
      if (method === '') return { ok: false, error: { code: 'bad-request', message: 'request needs a method' } };
      return { ok: true, value: await server.request(method, body.params ?? null) };
    }
    if (op === 'notify') {
      const method = stringOf(body.method);
      if (method === '') return { ok: false, error: { code: 'bad-request', message: 'notify needs a method' } };
      server.notify(method, body.params ?? null);
      return { ok: true, value: { root } };
    }

    /* 只有位置类 op 需要 line/character。这一句必须只压在它们身上：
       早先的写法是无条件校验，结果排在后面的 documentSymbol / workspaceSymbol /
       codeActions / diagnostics 全被挡成 bad-request（2026-11-02 定位）。 */
    const positionOp =
      op === 'hover' ||
      op === 'completion' ||
      op === 'definition' ||
      op === 'declaration' ||
      op === 'typeDefinition' ||
      op === 'references' ||
      op === 'documentHighlight' ||
      op === 'goal' ||
      op === 'termGoal';
    const position = positionOp ? positionOf(body) : undefined;
    if (positionOp && position === undefined) {
      return { ok: false, error: { code: 'bad-request', message: `${op} needs a non-negative line and character` } };
    }
    if (op === 'hover') return { ok: true, value: await server.hover(path, position) };
    if (op === 'completion') return { ok: true, value: await server.completion(path, position) };
    if (op === 'definition') return { ok: true, value: await server.definition(path, position) };
    if (op === 'declaration') return { ok: true, value: await server.declaration(path, position) };
    if (op === 'typeDefinition') return { ok: true, value: await server.typeDefinition(path, position) };
    if (op === 'references') {
      const includeDeclaration = body.includeDeclaration !== false;
      return { ok: true, value: await server.references(path, position, includeDeclaration) };
    }
    if (op === 'documentHighlight') return { ok: true, value: await server.documentHighlight(path, position) };
    if (op === 'goal') return { ok: true, value: await server.plainGoal(path, position) };
    if (op === 'termGoal') return { ok: true, value: await server.plainTermGoal(path, position) };

    if (op === 'foldingRange') {
      return { ok: true, value: { ranges: await server.foldingRanges(path) } };
    }
    if (op === 'documentSymbol') {
      return { ok: true, value: { symbols: await server.documentSymbols(path) } };
    }
    if (op === 'workspaceSymbol') {
      const query = stringOf(body.query);
      const limit = Number(body.limit);
      return {
        ok: true,
        value: { symbols: await server.workspaceSymbols(query, Number.isFinite(limit) ? limit : 50) },
      };
    }
    if (op === 'codeActions') {
      const range = rangeOf(body.range);
      if (range === undefined) {
        return { ok: false, error: { code: 'bad-request', message: 'codeActions needs a range' } };
      }
      /* Lean 靠诊断里的 code/source 决定生成哪条 action，所以必须把与该区间
         相交的诊断原样带回去——空数组会让它什么都不吐。 */
      const context = server.diagnosticsOf(path).filter((item) => intersects(item?.range, range));
      const actions = await server.codeActions(path, range, context);
      return { ok: true, value: { actions } };
    }
    if (op === 'diagnostics') {
      return {
        ok: true,
        value: {
          state: server.state,
          diagnostics: server.diagnosticsOf(path).map(wireDiagnostic),
          progress: server.progressOf(path).map((item) => ({
            startLine: Number(item?.range?.start?.line) || 0,
            endLine: Number(item?.range?.end?.line) || 0,
            kind: Number(item?.kind) || 0,
          })),
        },
      };
    }

    return { ok: false, error: { code: 'bad-request', message: `unknown op "${op}"` } };
  }

  /** LSP `Range` 的最小校验：四个非负整数。 */
  function rangeOf(value) {
    const start = positionOf(value?.start ?? {});
    const end = positionOf(value?.end ?? {});
    if (start === undefined || end === undefined) return undefined;
    return { start, end };
  }

  /** 两个 LSP 区间是否相交（行优先比较，够用：Lean 的诊断都是整行或更窄）。 */
  function intersects(left, right) {
    if (!left || !right) return false;
    const start = left.start ?? left;
    const end = left.end ?? left;
    const afterStart =
      start.line > right.end.line || (start.line === right.end.line && start.character >= right.end.character);
    if (afterStart) return false;
    const beforeEnd = end.line < right.start.line || (end.line === right.start.line && end.character <= right.start.character);
    return !beforeEnd;
  }

  /** Shared admission check: the web server is only reachable from the app. */
  function admitted(req) {
    const connection = ctx.connection;
    if (connection === undefined || typeof connection.requestRejection !== 'function') return true;
    return connection.requestRejection(req) === undefined;
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/lean-lsp/api',
      handler: async (req, res) => {
        hostLog(`api: ${req.method} ${req.url}`);
        if (!admitted(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
          return;
        }
        const read = await readJsonBody(req);
        if (!read.ok) {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: read.message } });
          return;
        }
        try {
          writeJson(res, 200, await handle(read.value));
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            error: {
              code: 'lsp-failed',
              message: error instanceof Error ? error.message : String(error),
              /* JSON-RPC 的错误码要原样带给浏览器：infoview 用它判 rpcNeedsReconnect（-32900）。 */
              ...(typeof error?.code === 'number' ? { rpcCode: error.code } : {}),
            },
          });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/lean-lsp/events',
      handler: (req, res) => {
        hostLog(`events: ${req.method} ${req.url}`);
        if (!admitted(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        subscribers.add(res);
        const drop = () => subscribers.delete(res);
        req.on?.('close', drop);
        req.on?.('error', drop);
        res.on?.('close', drop);
        if (heartbeat === null) {
          heartbeat = setInterval(() => {
            for (const subscriber of subscribers) {
              try {
                subscriber.write(': keep-alive\n\n');
              } catch {
                subscribers.delete(subscriber);
              }
            }
          }, HEARTBEAT_MS);
          heartbeat.unref?.();
        }
      },
    }),
  );

  hostLog('apply: routes registered (/lean-lsp/api, /lean-lsp/events)');

  ctx.effect(() => () => {
    hostLog('cleanup: plugin fiber disposed');
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    /* 先把「插件被卸载」这件事告诉浏览器，否则界面只会显示一个没有原因的「未连接」。 */
    for (const root of pool.keys()) {
      broadcast({ type: 'status', root, state: 'failed', detail: '插件被卸载（宿主半 dispose）' });
    }
    for (const { server } of pool.values()) {
      try {
        server.dispose('plugin-cleanup');
      } catch {
        // Best effort.
      }
    }
    pool.clear();
    subscribers.clear();
  });
}
