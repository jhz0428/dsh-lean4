// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 把官方 `@leanprover/infoview` 挂进侧边栏：它是普通的 React 应用，
// 只要实现 EditorApi（谁来发 LSP 请求、谁来改文本、光标在哪）就能跑。
//
// 这块代码刻意不碰 CodeMirror / DOM 细节：文本读写全部由调用方通过 `editor` 传进来，
// 于是可以在 Node 里用假对象单测整个协议面。

const INFOVIEW_STYLE_ID = 'dsh-lean-infoview-style';

/** 官方 CSS 里带 codicon 字体，体积大且只需要注入一次。 */
export function insertInfoviewStyle(doc, css) {
	if (typeof css !== 'string' || css === '') return;
	if (doc.getElementById(INFOVIEW_STYLE_ID) !== null) return;
	const style = doc.createElement('style');
	style.id = INFOVIEW_STYLE_ID;
	style.textContent = css;
	doc.head.appendChild(style);
}

/**
 * `$/lean/rpc/keepAlive` 的节奏。
 *
 * 服务器侧 `Lean/Server/FileWorker/Utils.lean:186-205` 写死 `keepAliveTimeMs := 30000`，
 * 过期就 `rpcSessions.erase`，之后任何 `$/lean/rpc/call` 都回 `-32900 Outdated RPC session`。
 * 上游 vscode-lean4 用的是 10 s（`src/infoview.ts` 的 `keepAlivePeriodMs`），这里照抄：
 * 30 s / 10 s = 3 次机会，丢一两条通知也不会掉线。别调大到接近 30 s——那就只剩一次机会，
 * 而宿主半重启、页面切后台节流都会丢通知。
 */
export const KEEP_ALIVE_MS = 10_000;
/** infoview 的 `ServerVersion.ofString` 只吃 `x.y` 或 `x.y.z`，其它一律抛错。 */
const SERVER_VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;

/**
 * 建立 infoview ↔ 编辑器 ↔ Lean 的三方桥。
 *
 * @param {object} options
 * @param {object} options.module     `{ renderInfoview }`（由 vendor bundle 提供）
 * @param {HTMLElement} options.element 挂载点
 * @param {object} options.client     `createLspClient` 的返回值，需要 `request` / `notify` / `restart`
 * @param {string} options.uri        当前文档 URI
 * @param {object} options.editor     `{ getText, getCursor, insertText, applyChanges, revealPosition }`
 * @param {object} [options.config]   infoview 的 13 项配置初值（见 `infoview-config.js`）
 * @param {(next: object) => void} [options.onConfigChange] 配置变化时回调（负责落盘 + 记日志）
 */
export function mountInfoview({ module, element, client, uri, editor, config, onConfigChange }) {
	const renderInfoview = module?.renderInfoview;
	if (typeof renderInfoview !== 'function') {
		const keys = module !== null && typeof module === 'object' ? Object.keys(module).slice(0, 6).join(',') : '—';
		throw new Error(`infoview 模块缺少 renderInfoview（收到 ${module === null ? 'null' : typeof module}；键：${keys || '空'}）`);
	}

	const serverNotifications = new Set();
	const clientNotifications = new Set();
	const sessions = new Map();
	/*
	 * 配置是 live 的：infoview 自己会改（面板里的右键菜单），我们也会改（设置区），
	 * 两边都必须看到同一份。`sameInfoviewConfig` 挡掉「值没变也回灌」的循环
	 * ——`changedInfoviewConfig` 会触发 infoview 重渲染，重渲染又可能再调 `saveConfig`。
	 */
	let currentConfig = config !== null && typeof config === 'object' ? { ...config } : null;
	const pushConfig = (next) => {
		currentConfig = next;
		if (typeof onConfigChange === 'function') onConfigChange({ ...next });
		Promise.resolve(events.changedInfoviewConfig?.({ ...next })).catch(() => {});
	};

	const api = {
		async saveConfig(next) {
			const merged = mergeInfoviewConfig(currentConfig, next);
			if (sameInfoviewConfig(merged, currentConfig)) return merged;
			pushConfig(merged);
			return merged;
		},
		async sendClientRequest(_uri, method, params) {
			return client.request(method, params);
		},
		async sendClientNotification(_uri, method, params) {
			/* 通知不等回执，但也不能留下未处理的 rejection（宿主半重启时会整片失败）。 */
			Promise.resolve(client.notify(method, params)).catch(() => {});
			if (clientNotifications.has(method)) events.sentClientNotification(method, params);
		},
		async subscribeServerNotifications(method) {
			serverNotifications.add(method);
		},
		async unsubscribeServerNotifications(method) {
			serverNotifications.delete(method);
		},
		async subscribeClientNotifications(method) {
			clientNotifications.add(method);
		},
		async unsubscribeClientNotifications(method) {
			clientNotifications.delete(method);
		},
		async copyToClipboard(text) {
			const value = String(text);
			try {
				if (globalThis.navigator?.clipboard?.writeText !== undefined) {
					await globalThis.navigator.clipboard.writeText(value);
					return;
				}
			} catch (error) {
				/* 落到下面的兜底：非安全上下文/权限被拒时 writeText 会抛。 */
			}
			const document = globalThis.document;
			if (document?.body === undefined) return;
			const area = document.createElement('textarea');
			area.value = value;
			area.setAttribute('readonly', '');
			area.style.position = 'fixed';
			area.style.opacity = '0';
			document.body.appendChild(area);
			try {
				area.select();
				document.execCommand?.('copy');
			} finally {
				area.remove();
			}
		},
		async insertText(text, kind, pos) {
			editor.insertText(String(text), kind, pos);
		},
		async applyEdit(workspaceEdit) {
			const changes = workspaceEdit?.changes?.[uri];
			if (Array.isArray(changes)) editor.applyChanges(changes);
		},
		async showDocument(show) {
			if (show?.uri !== undefined && show.uri !== uri) return;
			if (show?.selection !== undefined) editor.revealPosition(show.selection.start);
		},
		async restartFile() {
			await client.restart();
		},
		async createRpcSession() {
			const connected = await client.request('$/lean/rpc/connect', { uri });
			const sessionId = connected?.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('rpc/connect 没有返回 sessionId');
			const timer = globalThis.setInterval(() => {
				try {
					client.notify('$/lean/rpc/keepAlive', { uri, sessionId });
				} catch {
					/* 会话已经死了就算了，列表会由 closeRpcSession 清掉 */
				}
			}, KEEP_ALIVE_MS);
			sessions.set(sessionId, timer);
			return sessionId;
		},
		async closeRpcSession(sessionId) {
			const timer = sessions.get(sessionId);
			if (timer !== undefined) globalThis.clearInterval(timer);
			sessions.delete(sessionId);
			client.notify('$/lean/rpc/release', { uri, sessionId, refs: [] });
		},
	};

	const events = renderInfoview(api, element);
	// 官方前端要求宿主先告知初始位置，否则它不知道要显示哪个文件的 goal。
	const start = editor.getCursor();
	Promise.resolve(events.initialize?.({ uri, range: { start, end: start } }))
		/*
		 * `initialize` 之后才能喂配置：infoview 在 initialize 里才把 EditorConnection
		 * 建起来，早到的 `changedInfoviewConfig` 会被它丢掉（面板于是永远用默认值）。
		 */
		.then(() => {
			if (currentConfig !== null) events.changedInfoviewConfig?.({ ...currentConfig });
		})
		.catch(() => {});

	let disposed = false;
	return {
		/** 当前生效的配置（设置区渲染用）。 */
		config() {
			return currentConfig === null ? null : { ...currentConfig };
		},
		/** 外部（我们自己的设置区）改配置：存下来并回灌，与 infoview 自己改走同一条路。 */
		setConfig(next) {
			if (disposed) return null;
			const merged = mergeInfoviewConfig(currentConfig, next);
			if (sameInfoviewConfig(merged, currentConfig)) return currentConfig;
			pushConfig(merged);
			return merged;
		},
		/** 服务器（重新）就绪时喂给 infoview；不调用它 infoview 会一直显示 Waiting for Lean server。 */
		serverReady(capabilities, serverInfo) {
			if (disposed) return;
			/*
			 * infoview 会 `V.major/minor/patch` 解析 `serverInfo.version`，解析不了就
			 * throw —— 在它自己的 React 树里抛，结果是整个面板白掉（连报错都不显示）。
			 * 所以版本号不成立时宁可不喂，等真正 initialize 结果到了再说。
			 */
			const version = serverInfo !== null && typeof serverInfo === 'object' ? serverInfo.version : undefined;
			if (typeof version !== 'string' || !SERVER_VERSION_PATTERN.test(version.trim())) return;
			events.serverRestarted?.({ capabilities: capabilities ?? {}, serverInfo });
		},
		serverStopped(reason, message) {
			if (disposed) return;
			events.serverStopped?.({ reason: String(reason ?? ''), message: String(message ?? '') });
		},
		/** 光标移动：infoview 靠这个决定显示哪个位置的 goal / widget。 */
		cursor(position) {
			if (disposed) return;
			events.changedCursorLocation?.({ uri, range: { start: position, end: position } });
		},
		/** 把 SSE 推来的通知转给订阅者（`$/lean/fileProgress` 等）。 */
		notification(method, params) {
			if (disposed) return;
			if (!serverNotifications.has(method)) return;
			events.gotServerNotification?.(method, params);
		},
		dispose() {
			disposed = true;
			for (const timer of sessions.values()) globalThis.clearInterval(timer);
			sessions.clear();
			if (typeof element.replaceChildren === 'function') element.replaceChildren();
		},
	};
}
