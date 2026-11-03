// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 把 CodeMirror 6 装成一个「可编辑的 Lean 文件视图」。
//
// CodeMirror 不在这里 import：它是构建期由 rolldown 打包成 IIFE 全局的（见
// tools/build-lean-editor.mjs），运行时以参数 `kit` 传进来。这样这个文件既能被
// 构建脚本内联，也能被 Node 单测直接 import（不碰 DOM 的部分）。

import { LEAN_SPEC } from './lean-mode.js';

/**
 * 主题：所有颜色都走 CSS 变量，并给出 One-Dark 家族的回退值。
 *
 * 变量名刻意用 `--dle-*` 前缀，由 style.js 在 `:root` 上定义成
 * `--dle-keyword: var(--shiki-token-keyword, #c678dd)`：宿主有 shiki 那套 token
 * 变量时自动跟随 DSH 主题，没有时落到回退色，不会出现「白底白字」。
 */
function highlightStyleOf(kit) {
	const { HighlightStyle, tags: t } = kit;
	return HighlightStyle.define([
		{ tag: [t.comment], color: 'var(--dle-comment)', fontStyle: 'italic' },
		{ tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: 'var(--dle-keyword)' },
		{ tag: [t.string, t.special(t.string)], color: 'var(--dle-string)' },
		{ tag: [t.number, t.bool, t.atom, t.null], color: 'var(--dle-constant)' },
		{ tag: [t.typeName, t.className, t.namespace], color: 'var(--dle-type)' },
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--dle-function)' },
		{ tag: [t.variableName, t.propertyName, t.attributeName], color: 'var(--dle-variable)' },
		{ tag: [t.operator, t.punctuation, t.bracket], color: 'var(--dle-operator)' },
		{ tag: [t.invalid], color: 'var(--dle-invalid)', textDecoration: 'underline wavy' }
	]);
}

/**
 * 判断挂载点所在的面板是深色还是浅色。
 *
 * 只看 `color` 不够稳：DSH 的文字色经常是继承来的 `inherit` 或半透明，
 * 算不出亮度时就会误判成浅色，然后 CodeMirror 按浅色主题给 tooltip 刷白底、
 * 给选区刷 `#d9d9d9` —— 在深色侧边栏里就是「提示框一片白、字看不清」。
 * 所以先沿祖先链找第一个**不透明**的背景色，用它算亮度；找不到再用文字色兜底。
 */
export function isDarkSurface(host) {
	const luminanceOf = (value) => {
		const parts = typeof value === 'string' ? value.match(/[\d.]+/g) : null;
		if (parts === null || parts.length < 3) return null;
		// 背景全透明时 rgba 的第 4 位是 0，等于没有背景，继续往上找。
		if (parts.length >= 4 && Number(parts[3]) === 0) return null;
		const [r, g, b] = parts.slice(0, 3).map(Number);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	try {
		let node = host;
		for (let depth = 0; node !== null && node !== undefined && depth < 24; depth += 1) {
			const style = getComputedStyle(node);
			const background = luminanceOf(style.backgroundColor);
			if (background !== null) return background < 128;
			node = node.parentElement;
		}
		const text = luminanceOf(getComputedStyle(host).color);
		if (text !== null) return text > 128;
	} catch {
		/* 量不到就按深色处理：DSH 默认是深色主题。 */
	}
	return true;
}

/** 编辑器外观：等宽字体、透明底（跟随侧边栏背景）、窄行号栏。 */
function themeOf(kit, dark) {
	const { EditorView } = kit;
	return EditorView.theme({
		'&': {
			height: '100%',
			backgroundColor: 'transparent',
			color: 'var(--dle-foreground, inherit)',
			fontFamily: 'var(--dsw-font-markdown-code-block, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
			fontSize: 'var(--dle-font-size, 12.5px)'
		},
		'.cm-scroller': { lineHeight: '1.65', overflow: 'auto' },
		'.cm-content': { caretColor: 'var(--dle-foreground, currentColor)', padding: '10px 0' },
		'.cm-line': { padding: '0 12px 0 4px' },
		'.cm-gutters': {
			backgroundColor: 'transparent',
			color: 'var(--dle-gutter, color-mix(in srgb, currentColor 42%, transparent))',
			border: 'none',
			paddingLeft: '6px'
		},
		'.cm-activeLine': { backgroundColor: 'var(--dle-active-line, color-mix(in srgb, currentColor 5%, transparent))' },
		'.cm-activeLineGutter': { backgroundColor: 'transparent' },
		'&.cm-focused': { outline: 'none' },
		// 选择器的形状与 CodeMirror 自带主题一致（`&dark.cm-focused > .cm-scroller >
		// .cm-selectionLayer …`），否则会被它那套 `#d9d9d9` 浅色默认值压掉；
		// `!important` 只是保险，两层都写是为了聚焦/失焦都对。
		'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
			backgroundColor: 'var(--dle-selection, color-mix(in srgb, currentColor 24%, transparent)) !important'
		},
		'.cm-content ::selection, .cm-content::selection': { backgroundColor: 'transparent' },
		'.cm-selectionMatch': {
			backgroundColor: 'var(--dle-selection-match, color-mix(in srgb, currentColor 12%, transparent))'
		},
		'.cm-searchMatch': {
			backgroundColor: 'var(--dle-search-match, color-mix(in srgb, #e5c07b 40%, transparent))'
		},
		'.cm-cursor': { borderLeftColor: 'var(--dle-foreground, currentColor)' },
		/*
		 * 浮层（悬停提示、补全菜单、lint 详情）不能靠 CodeMirror 的默认主题：
		 * 它按 `{ dark }` 二选一，一旦判定失误就是白底 + 浅色字。
		 * 这里用面板自己的令牌固定下来，明暗两边都读得清。
		 */
		'.cm-tooltip, .cm-tooltip-lint, .cm-tooltip-autocomplete': {
			// !important 是必要的：CodeMirror 的 baseTheme 用 `&light .cm-tooltip`
			// 这一档更高特异性的选择器刷浅色底，只靠普通声明会被它压过去。
			backgroundColor: 'var(--dle-overlay-bg, var(--dsw-alias-bg-elevated, #23262d)) !important',
			color: 'var(--dle-overlay-fg, var(--dle-foreground, #d4d4d4)) !important',
			border: '1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.35))',
			borderRadius: '6px',
			boxShadow: '0 10px 28px rgba(0, 0, 0, 0.38)',
			fontFamily: 'var(--dsw-font-markdown-code-block, ui-monospace, monospace)',
			fontSize: '12px',
			overflow: 'hidden',
			zIndex: '40'
		},
		'.cm-tooltip > .dle-hover': { backgroundColor: 'transparent' },
		'.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '240px' },
		'.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
		'.cm-tooltip-autocomplete > ul > li[aria-selected]': {
			backgroundColor: 'color-mix(in srgb, currentColor 20%, transparent)',
			color: 'inherit'
		},
		'.cm-completionDetail': { color: 'var(--dsw-alias-text-secondary, #9aa0a6)', fontStyle: 'normal' },
		'.cm-tooltip-lint .cm-diagnostic': {
			borderLeftColor: 'var(--dle-invalid, #e06c75)',
			fontFamily: 'var(--dsw-font-sans, system-ui, sans-serif)'
		}
	}, { dark });
}

/**
 * 在 `host` 元素里创建一个 CodeMirror 实例。
 *
 * @param kit - `globalThis.DCM`：构建期打包出来的 CodeMirror 子集。
 * @param host - 挂载点（一个空的 div）。
 * @param options.doc - 初始文本。
 * @param options.onDocChanged - 用户编辑后回调（宿主注入的 setDoc 不会触发）。
 * @param options.onSave - Ctrl/Cmd+S 时回调。
 * @param options.onContextMenu - 右键时回调（`{ clientX, clientY, hasSelection }`）。
 * @param options.onGotoDefinition - Ctrl/Cmd+点击时回调位置 `{ line, character }`（0 基）。
 * @param options.extras - 追加到状态里的扩展（注释渲染、行号栏标记等）。
 * @returns `{ view, getDoc, setDoc, revealLine, focus, destroy }`。
 */
export function mountEditor(kit, host, options) {
	const { EditorState, EditorView, keymap, lineNumbers, highlightActiveLine, history, historyKeymap, defaultKeymap, indentWithTab, syntaxHighlighting, StreamLanguage, bracketMatching, indentOnInput, drawSelection, highlightSelectionMatches, searchKeymap } = kit;
	const doc = typeof options.doc === 'string' ? options.doc : '';
	/** 宿主主动换文档时置位，避免把一次 reload 记成「用户改的」。 */
	let applyingHost = false;

	const saveBinding = {
		key: 'Mod-s',
		preventDefault: true,
		run: () => {
			options.onSave?.();
			return true;
		}
	};

	const state = EditorState.create({
		doc,
		extensions: [
			EditorState.tabSize.of(2),
			/* extras 放最前面：gutter 的顺序 = 注册顺序，证明完成标记要出现在行号栏左侧。 */
			...(Array.isArray(options.extras) ? options.extras : []),
			lineNumbers(),
			highlightActiveLine(),
			drawSelection(),
			history(),
			indentOnInput(),
			bracketMatching(),
			highlightSelectionMatches(),
			StreamLanguage.define(LEAN_SPEC),
			syntaxHighlighting(highlightStyleOf(kit)),
			keymap.of([saveBinding, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
			// 右键菜单交给外壳画：编辑器只报坐标与「有没有选区」。
			EditorView.domEventHandlers({
				contextmenu(event, view) {
					if (options.onContextMenu === undefined) return false;
					const range = view.state.selection.main;
					options.onContextMenu({
						clientX: event.clientX,
						clientY: event.clientY,
						hasSelection: range.to > range.from
					});
					event.preventDefault();
					return true;
				},
				/*
				 * Ctrl+Click（macOS 上 Cmd+Click）= 跳转到定义，和 VS Code 一致。
				 *
				 * 必须拦在 `mousedown`：CodeMirror 自己的 Ctrl+Click 是「加多光标」，
				 * 等它处理完选区已经变了，再问定义就会问到错误的位置。返回 true 并
				 * preventDefault 把默认行为整个吃掉。
				 */
				mousedown(event, view) {
					if (options.onGotoDefinition === undefined) return false;
					if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false;
					const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
					if (position === null || position === undefined) return false;
					const at = view.state.doc.lineAt(position);
					options.onGotoDefinition({ line: at.number - 1, character: position - at.from });
					event.preventDefault();
					return true;
				}
			}),
			themeOf(kit, isDarkSurface(host)),
			EditorView.updateListener.of((update) => {
				// 光标移动要单独报：infoview 靠它决定显示哪个位置的 goal。
				if (update.selectionSet || update.docChanged) {
					const head = update.state.selection.main.head;
					const line = update.state.doc.lineAt(head);
					options.onCursor?.({
						line: line.number - 1,
						character: head - line.from,
						offset: head
					});
				}
				if (!update.docChanged) return;
				if (applyingHost) return;
				options.onDocChanged?.();
			})
		]
	});

	const view = new EditorView({ state, parent: host });

	return {
		view,
		getDoc: () => view.state.doc.toString(),
		setDoc(text) {
			const current = view.state.doc.toString();
			if (current === text) return;
			applyingHost = true;
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
			applyingHost = false;
		},
		/** 把第 `lineNo` 行（1 基）滚到视野中间并把光标放过去。 */
		revealLine(lineNo) {
			const total = view.state.doc.lines;
			const target = Math.min(Math.max(1, Math.trunc(lineNo)), total);
			const line = view.state.doc.line(target);
			view.dispatch({
				selection: { anchor: line.from },
				effects: EditorView.scrollIntoView(line.from, { y: 'center' })
			});
		},
		focus: () => view.focus(),
		destroy: () => view.destroy()
	};
}
