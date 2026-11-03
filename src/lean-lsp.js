// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 浏览器半的 Lean LSP 客户端：只做一件事——把 `/lean-lsp/api` 翻译成
// 「打开/修改/悬停/补全/目标」，并把 `/lean-lsp/events` 的推送分发给 UI。
//
// 设计取舍：
//   * 不带状态缓存。诊断以推送为准（挂载时先做一次 `pull` 补齐），否则很容易
//     出现「服务器说 A、界面显示 B」。每次打开文件都从 `open` 开始。
//   * 不引入任何 CodeMirror 依赖，便于 Node 单测（fetch / EventSource 都可注入）。
//   * `path` 用绝对路径；URI 在这里自己拼，和宿主 `pathToFileURL` 的结果对齐。

/**
 * `D:\dir\a b.lean` → `file:///D:/dir/a%20b.lean`
 *
 * 与 Node 的 `pathToFileURL` 保持同一形状：盘符后的冒号保留，其余按段编码。
 */
export function fileUriOf(path) {
	const normalized = String(path).replace(/\\/g, '/');
	const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
	const encoded = prefixed
		.split('/')
		.map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
		.join('/');
	return `file://${encoded}`;
}

/**
 * 统一错误形状：传输层失败和 `{ok:false}` 都变成 Error。
 *
 * `code` 的取值有讲究：infoview 判的是 `ex?.code === -32900`（RpcErrorCode.RpcNeedsReconnect），
 * 用来决定「丢掉旧 RPC 会话、重建一个再试」。所以宿主半带回来的 JSON-RPC 数字码必须原样写到
 * `code` 上（我们自己的种类名退到 `kind`），否则它把这个错误当成普通失败一直显示，
 * 界面上就是永远消不掉的「Outdated RPC session. Try again.」。
 */
function failureOf(payload, fallback) {
	if (payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object') {
		const message = typeof payload.error.message === 'string' ? payload.error.message : fallback;
		const error = new Error(message);
		error.kind = typeof payload.error.code === 'string' ? payload.error.code : 'unknown';
		error.code = typeof payload.error.rpcCode === 'number' ? payload.error.rpcCode : error.kind;
		return error;
	}
	return new Error(fallback);
}

/**
 * @param {object} options
 * @param {string} options.baseUrl   形如 `http://127.0.0.1:61253/`（页面 origin）。
 * @param {string} options.path      被编辑文件的绝对路径。
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.EventSourceImpl]
 */
export function createLspClient(options) {
	const path = options.path;
	const uri = fileUriOf(path);
	const base = new URL('lean-lsp/', options.baseUrl);
	const apiUrl = new URL('api', base).href;
	const eventsUrl = new URL('events', base).href;
	const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
	const EventSourceImpl = options.EventSourceImpl ?? (typeof EventSource === 'undefined' ? undefined : EventSource);

	const handlers = new Set();
	let source = null;
	let closed = false;
	let pollTimer = null;
	let lastPull = null;
	/** 上次广播出去的状态摘要：轮询同一份状态时不重复 emit。 */
	let lastDigest = '';

	function emit(event) {
		for (const handler of handlers) {
			try {
				handler(event);
			} catch {
				// 订阅方的异常不能打断其它订阅方。
			}
		}
	}

	async function call(op, extra) {
		if (closed) throw new Error('LSP 客户端已关闭');
		let response;
		try {
			response = await fetchImpl(apiUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op, path, ...extra }),
			});
		} catch (error) {
			throw new Error(`连不上 Lean 服务（${error instanceof Error ? error.message : String(error)}）`);
		}
		let payload = null;
		try {
			payload = await response.json();
		} catch {
			payload = null;
		}
		if (payload === null || typeof payload !== 'object') {
			throw new Error(`Lean 服务返回了无法解析的响应（HTTP ${response.status}）`);
		}
		if (payload.ok !== true) throw failureOf(payload, `Lean 服务拒绝了 ${op}（HTTP ${response.status}）`);
		return payload.value;
	}

	/**
	 * 兜底轮询。
	 *
	 * 不只「SSE 断开时」才轮询：DSH 的 webServer 路由可能被代理缓冲，SSE 连接
	 * 状态是 open 但事件永远不落地。所以只要订阅了就一直低频拉取，SSE 只是
	 * 让更新更快；`pull()` 内部用 digest 去重，重复轮询不会造成重渲染。
	 */
	function startPolling() {
		if (pollTimer !== null || closed) return;
		pollTimer = setInterval(() => {
			pull().catch(() => {
				// 轮询失败保持安静，状态会由下一次成功刷新。
			});
		}, 4000);
	}

	function stopPolling() {
		if (pollTimer === null) return;
		clearInterval(pollTimer);
		pollTimer = null;
	}

	function subscribe() {
		startPolling();
		/*
		 * 立刻拉一次：SSE 只推「变化」，而 `lastPull` 里的 serverInfo / capabilities
		 * 是 infoview 启动必需的。不先拉，第一次 `ready` 事件会比任何 pull 都早到，
		 * 宿主半给的字段就成了 undefined——那一片面板会直接渲染失败。
		 */
		void pull().catch(() => {});
		if (EventSourceImpl === undefined) return;
		try {
			source = new EventSourceImpl(eventsUrl);
		} catch {
			return;
		}
		source.onmessage = (message) => {
			let event;
			try {
				event = JSON.parse(message.data);
			} catch {
				return;
			}
			if (event === null || typeof event !== 'object') return;
			if (event.uri !== undefined && event.uri !== uri) return;
			emit(event);
			if (event.type === 'diagnostics') lastPull = null;
		};
		source.onerror = () => {
			/* SSE 断了无所谓：兜底轮询一直在跑。 */
		};
		source.onopen = () => {
			/* 不清轮询，理由见 startPolling 的注释。 */
		};
	}

	async function pull() {
		const value = await call('pull', {});
		lastPull = value;
		if (value !== null && typeof value === 'object') {
			const digest = JSON.stringify([value.state, value.diagnostics ?? [], value.progress ?? []]);
			if (digest === lastDigest) return value;
			lastDigest = digest;
			emit({ type: 'status', state: value.state });
			emit({ type: 'diagnostics', uri, diagnostics: value.diagnostics ?? [] });
			emit({ type: 'progress', uri, processing: value.progress ?? [] });
		}
		return value;
	}

	return {
		uri,
		path,
		/** 订阅推送；返回取消函数。订阅时会顺带建立 SSE 连接并做一次全量拉取。 */
		onEvent(handler) {
			const first = handlers.size === 0;
			handlers.add(handler);
			if (first) {
				subscribe();
			}
			return () => {
				handlers.delete(handler);
				if (handlers.size === 0) {
					source?.close?.();
					source = null;
					stopPolling();
				}
			};
		},
		open: (text) => call('open', { text }),
		change: (text) => call('change', { text }),
		close: () => call('close', {}),
		pull,
		hover: (position) => call('hover', position),
		completion: (position) => call('completion', position),
		definition: (position) => call('definition', position),
		declaration: (position) => call('declaration', position),
		typeDefinition: (position) => call('typeDefinition', position),
		references: (position, includeDeclaration = true) => call('references', { ...position, includeDeclaration }),
		documentHighlight: (position) => call('documentHighlight', position),
		goal: (position) => call('goal', position),
		/** 折叠区间：`{ranges: [{startLine, endLine, kind}]}`（0 基）。 */
		foldingRanges: () => call('foldingRange', {}),
		/** 文档大纲：`{symbols: [{name, kind, container, range}]}`。 */
		documentSymbols: () => call('documentSymbol', {}),
		workspaceSymbols: (query) => call('workspaceSymbol', { query }),
		/** 建议（`Try this`）：`{actions: [...]}`；没有诊断相交的区间返回空数组。 */
		codeActions: (range, diagnostics) => call('codeActions', { range, diagnostics }),
		/** 当前文档的诊断与进度快照（未过滤，含 `isSilent` 的 GoalsAccomplished）。 */
		diagnostics: () => call('diagnostics', {}),
		/** 原样转发 LSP 请求（infoview 的 `$/lean/rpc/*` 走这里）。 */
		request: (method, params) => call('request', { method, params }),
		/** 原样转发 LSP 通知（`$/lean/rpc/release`、`keepAlive`）。 */
		notify: (method, params) => call('notify', { method, params }),
		restart: () => call('restart', {}),
		get lastPull() {
			return lastPull;
		},
		dispose() {
			closed = true;
			handlers.clear();
			source?.close?.();
			source = null;
			stopPolling();
		},
	};
}
