// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 把 Lean LSP 接进一个已经存在的 CodeMirror 实例。
//
// 为什么是「挂载后追加扩展」而不是在 EditorState.create 里一次性给出：LSP 客户端
// 需要 `view` 才能把诊断写回去，而扩展数组是在 `view` 之前构造的。用
// `StateEffect.appendConfig` 追加既避免了这个先后顺序，也让「关掉 LSP 后编辑器
// 仍然可用」成为默认行为。
//
// 所有 CodeMirror 能力都从 `kit`（globalThis.DCM）取，本文件不 import 任何包。

/** LSP `DiagnosticSeverity` → CodeMirror 的档位。 */
function severityOf(value) {
	if (value === 2) return 'warning';
	if (value === 3) return 'info';
	if (value === 4) return 'hint';
	return 'error';
}

/** LSP `CompletionItemKind` → CodeMirror 的图标类别。 */
const COMPLETION_TYPES = {
	2: 'method',
	3: 'function',
	4: 'function',
	5: 'property',
	6: 'variable',
	7: 'class',
	8: 'interface',
	9: 'namespace',
	10: 'property',
	13: 'variable',
	14: 'keyword',
	15: 'text',
	21: 'constant',
	22: 'class',
	25: 'type',
};

/*
 * `lintGutter` 只留 error/warning：info 级在 CodeMirror 的 baseTheme 里画的是一个
 * 描边方块（`M5 5L35 5L35 35L5 35Z`），而 Lean 的每条 `#eval` 输出都是一条 info
 * 诊断——整列方块会把「证明完成」的对勾淹掉，用户也认不出那是什么。
 *
 * 导出成纯函数是为了能单测：`lintGutter` 的 `markerFilter` 只在 view 挂载后才会被
 * 调用，纯 state 测试够不着它。
 */
export function keepSevereMarkers(list) {
	if (!Array.isArray(list)) return [];
	return list
		.filter((item) => item !== null && item !== undefined)
		.filter((item) => item.severity === 'error' || item.severity === 'warning');
}

/** 光标偏移 → LSP 位置（UTF-16 列号，与 JS 字符串一致）。 */
export function positionAt(doc, offset) {
	const clamped = Math.min(Math.max(0, offset), doc.length);
	const line = doc.lineAt(clamped);
	return { line: line.number - 1, character: clamped - line.from };
}

/** LSP 位置 → 文档偏移；行列都做裁剪，越界不会抛。 */
export function offsetOf(doc, line, character) {
	const target = Math.min(Math.max(1, (Number(line) || 0) + 1), doc.lines);
	const documentLine = doc.line(target);
	return Math.min(documentLine.from + Math.max(0, Number(character) || 0), documentLine.to);
}

/** 服务器诊断 → CodeMirror 诊断。 */
export function toCmDiagnostics(doc, list) {
	const out = [];
	for (const item of Array.isArray(list) ? list : []) {
		if (item === null || typeof item !== 'object') continue;
		/*
		 * 静默诊断是 Lean 给编辑器做装饰用的（`isSilent`，目前只有「目标已完成」），
		 * 它不该出现在问题列表里——否则行号栏会冒出一排「未知方块」，看起来像故障。
		 * 这些行由 `gutter-marks.js` 画成 ✓✓。
		 */
		if (item.isSilent === true) continue;
		let from = offsetOf(doc, item.startLine, item.startCharacter);
		let to = offsetOf(doc, item.endLine, item.endCharacter);
		if (to < from) [from, to] = [to, from];
		/* 零宽诊断在编辑器里看不见：给一个字符的宽度，但不要越过行尾。 */
		if (to === from) to = Math.min(from + 1, doc.length);
		out.push({
			from,
			to,
			severity: severityOf(item.severity),
			message: typeof item.message === 'string' ? item.message : '(没有消息)',
			source: typeof item.source === 'string' && item.source !== '' ? item.source : 'lean',
		});
	}
	return out;
}

/** 悬停面板：把 ``` 围栏块渲染成 `<pre>`，其余按段落排。 */
function renderHoverBody(document, text) {
	const wrapper = document.createElement('div');
	wrapper.className = 'dle-hover';
	const blocks = String(text).split(/```[a-zA-Z0-9]*\n?/);
	blocks.forEach((block, index) => {
		if (block.trim() === '') return;
		if (index % 2 === 1) {
			const pre = document.createElement('pre');
			pre.className = 'dle-hover-code';
			pre.textContent = block.replace(/\n$/, '');
			wrapper.append(pre);
		} else {
			const paragraph = document.createElement('div');
			paragraph.className = 'dle-hover-text';
			paragraph.textContent = block.trim();
			wrapper.append(paragraph);
		}
	});
	return wrapper;
}

/**
 * 挂上 LSP 行为。
 *
 * @param kit   `globalThis.DCM`
 * @param view  已创建的 EditorView
 * @param client `createLspClient(...)` 的结果
 * @param hooks `{ onGoal, onStatus, onProgress, onDiagnosticsRaw }`（都可选）
 *   `onDiagnosticsRaw` 收**未过滤**的原始诊断列表：`leanTags: [2]` 的「目标已完成」
 *   诊断带 `isSilent: true`，会被 `toCmDiagnostics` 剔除，只能从这里拿到。
 * @returns `{ dispose, syncNow }`
 */
export function attachLsp(kit, view, client, hooks = {}) {
	const { StateEffect } = kit;
	const document = view.dom.ownerDocument;
	let disposed = false;

	let changeTimer = null;
	let goalTimer = null;
	let goalInFlight = 0;
	let pendingDiagnostics = null;
	/* 服务器会死（崩溃、被外部杀掉、宿主半重载）。退避重连，别让用户只能重启应用。 */
	let retryTimer = null;
	let retries = 0;
	const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000];

	function reportDiagnostics(list) {
		if (disposed) return;
		try {
			view.dispatch(kit.setDiagnostics(view.state, list));
		} catch {
			// 编辑器已经销毁（切标签的竞态）时忽略。
		}
	}

	function refreshDiagnostics(list) {
		pendingDiagnostics = list;
		/*
		 * 两个消费者要的数据不同，必须分开送：
		 * - `hooks.onDiagnostics` 拿**原始**列表——`leanTags: [2]` 的「目标已完成」诊断
		 *   全是 `isSilent: true`，而 `toCmDiagnostics` 会把它们过滤掉（那些行由
		 *   gutter 画对勾）。先过滤再送，对勾就永远拿不到行号。
		 * - `setDiagnostics` 拿过滤后的列表——沉默诊断不该出现在行号栏的问题标记里。
		 */
		hooks.onDiagnosticsRaw?.(Array.isArray(list) ? list : []);
		reportDiagnostics(toCmDiagnostics(view.state.doc, list));
	}

	async function syncDocument() {
		if (disposed) return;
		try {
			await client.change(view.state.doc.toString());
		} catch (error) {
			hooks.onStatus?.({ state: 'failed', detail: error instanceof Error ? error.message : String(error) });
		}
	}

	function scheduleSync() {
		if (changeTimer !== null) clearTimeout(changeTimer);
		changeTimer = setTimeout(() => {
			changeTimer = null;
			void syncDocument();
		}, 400);
	}

	async function refreshGoal() {
		if (disposed) return;
		const selection = view.state.selection.main;
		if (!selection.empty) return;
		const token = ++goalInFlight;
		try {
			const goal = await client.goal(positionAt(view.state.doc, selection.head));
			if (disposed || token !== goalInFlight) return;
			hooks.onGoal?.(goal);
		} catch {
			// 光标在注释/字符串里时服务器会直接拒绝，这不是错误。
		}
	}

	function scheduleGoal() {
		if (goalTimer !== null) clearTimeout(goalTimer);
		goalTimer = setTimeout(() => {
			goalTimer = null;
			void refreshGoal();
		}, 260);
	}

	const listener = kit.EditorView.updateListener.of((update) => {
		if (update.docChanged) scheduleSync();
		if (update.selectionSet || update.docChanged) scheduleGoal();
	});

	const completionSource = async (context) => {
		const word = context.matchBefore(/[\w.'!?]*/);
		if (word === null) return null;
		if (word.from === word.to && !context.explicit) return null;
		try {
			const result = await client.completion(positionAt(context.state.doc, context.pos));
			if (result.items.length === 0) return null;
			return {
				from: word.from,
				options: result.items.slice(0, 300).map((item) => ({
					label: item.label,
					type: COMPLETION_TYPES[item.kind] ?? undefined,
					detail: item.detail === '' ? undefined : item.detail,
					info: item.documentation === '' ? undefined : item.documentation,
					apply: item.insertText === '' ? item.label : item.insertText,
				})),
			};
		} catch {
			return null;
		}
	};

	const hover = kit.hoverTooltip(
		async (currentView, pos) => {
			let result;
			try {
				result = await client.hover(positionAt(currentView.state.doc, pos));
			} catch {
				return null;
			}
			if (result === null) return null;
			return {
				pos,
				end: pos + 1,
				create() {
					return { dom: renderHoverBody(document, result.text) };
				},
			};
		},
		{ hoverTime: 320 }
	);

	/*
	 * `lintGutter` 只留 error/warning（见 `keepSevereMarkers` 的说明）。
	 */
	const extra = [
		listener,
		hover,
		kit.lintGutter({ markerFilter: keepSevereMarkers }),
		kit.keymap.of(kit.completionKeymap)
	];
	extra.push(kit.autocompletion({ override: [completionSource], activateOnTyping: true, maxRenderedOptions: 60 }));
	view.dispatch({ effects: StateEffect.appendConfig.of(extra) });

	const unsubscribe = client.onEvent((event) => {
		if (disposed || event === null || typeof event !== 'object') return;
		if (event.type === 'diagnostics') {
			refreshDiagnostics(Array.isArray(event.diagnostics) ? event.diagnostics : []);
			return;
		}
		if (event.type === 'status') {
			hooks.onStatus?.(event);
			if (event.state === 'ready') {
				retries = 0;
				void refreshGoal();
			}
			if (event.state === 'failed') scheduleRetry();
			return;
		}
		if (event.type === 'progress') {
			const processing = Array.isArray(event.processing) ? event.processing : [];
			hooks.onProgress?.(processing);
		}
	});

	/** 退避重连：`open` 会把当前文本重新推过去，服务器按需重建（宿主半负责）。 */
	async function reconnect() {
		if (disposed) return;
		try {
			await client.open(view.state.doc.toString());
			await client.pull();
			scheduleGoal();
		} catch {
			scheduleRetry();
		}
	}

	function scheduleRetry() {
		if (disposed || retryTimer !== null) return;
		/* 10 次 ≈ 4 分钟；再失败就让用户点「重启」，别无限打空请求。 */
		if (retries >= 10) return;
		const delay = RETRY_DELAYS[Math.min(retries, RETRY_DELAYS.length - 1)];
		retries += 1;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void reconnect();
		}, delay);
	}

	void (async () => {
		try {
			await client.open(view.state.doc.toString());
			await client.pull();
			scheduleGoal();
		} catch (error) {
			hooks.onStatus?.({ state: 'failed', detail: error instanceof Error ? error.message : String(error) });
			scheduleRetry();
		}
	})();

	return {
		/** 立即把当前文档推给服务器（例如「重启服务器」之后）。 */
		syncNow: () => syncDocument(),
		refreshGoal,
		/** 手动重连（状态条上的「重启」按钮）。 */
		reconnect,
		dispose() {
			disposed = true;
			if (changeTimer !== null) clearTimeout(changeTimer);
			if (goalTimer !== null) clearTimeout(goalTimer);
			if (retryTimer !== null) clearTimeout(retryTimer);
			unsubscribe();
			void client.close().catch(() => {});
		},
	};
}
