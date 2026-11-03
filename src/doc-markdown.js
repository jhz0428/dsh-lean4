// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 把 Lean 的文档注释就地渲染成 markdown（「内联块」方案）。
//
// 做法：用一个 StateField 产出 block 装饰，把注释所占的整段行替换成一个
// WidgetType。光标一旦进入那段范围就还原成源码——点一下注释即可编辑，不需要
// 额外的开关。
//
// 为什么是 StateField 而不是 ViewPlugin：CodeMirror 明确禁止插件（ViewPlugin）
// 提供 block 装饰——block 装饰会改变行高、参与布局测量，只能从 state 侧给出，
// 否则运行时抛 `Block decorations may not be specified via plugins`。
//
// 三条安全规则：
//   1. 只处理「独占整行」的注释。注释前后还有代码时跳过，否则替换整行会吞掉代码。
//   2. 未闭合的注释不渲染（内容是半截的，渲染出来只会误导）。
//   3. 渲染失败就退成等宽原文，不抛异常。

import { renderableBlocks } from './lean-comments.js';
import { renderMarkdown } from './markdown-lite.js';

/**
 * @param kit - `globalThis.DCM`。
 * @returns `{ extension, setEnabled, enabledField, decorationsField }`。
 */
export function createDocMarkdown(kit) {
	const { Decoration, WidgetType, EditorView, StateEffect, StateField } = kit;

	/* 渲染开关做成 StateField 而不是重建扩展：状态栏那个按钮只 dispatch 一个 effect。 */
	const setEnabled = StateEffect.define();
	const enabledField = StateField.define({
		create: () => true,
		update(value, transaction) {
			let next = value;
			for (const effect of transaction.effects) {
				if (effect.is(setEnabled)) next = effect.value === true;
			}
			return next;
		}
	});

	class DocCommentWidget extends WidgetType {
		constructor(body, kind) {
			super();
			this.body = body;
			this.kind = kind;
		}

		/* eq 返回 true 时 CodeMirror 复用已有 DOM，不会重跑 React 渲染。 */
		eq(other) {
			return other instanceof DocCommentWidget && other.body === this.body && other.kind === this.kind;
		}

		/*
		 * 块装饰的高度初值。
		 *
		 * WidgetType 默认返回 -1，CodeMirror 会先按「一行行高」估位，等真实测量
		 * （getBoundingClientRect）回来再纠正——纠正的那一下就是滚动/方向键看到的
		 * 「跳一下」。这里按渲染后的规模给个近似值，让首帧就八九不离十。
		 *
		 * 只是估值：真实高度仍以测量为准，CSS 改版不会因此错位。
		 */
		get estimatedHeight() {
			const lines = this.body.split('\n').length;
			/* 13px 字号 × 1.5 行高 ≈ 19.5px，上下 padding 共 30px。 */
			return Math.max(24, Math.round(lines * 19.5) + 30);
		}

		toDOM() {
			const host = document.createElement('div');
			host.className = 'dle-doc';
			host.dataset.kind = this.kind;
			const content = document.createElement('div');
			content.className = 'dle-doc-body';
			host.appendChild(content);
			try {
				const html = renderMarkdown(this.body);
				if (html === '') content.textContent = this.body;
				else content.innerHTML = html;
			} catch (error) {
				content.textContent = this.body;
				host.dataset.failed = 'true';
				console.warn('[dsh-lean4] 注释渲染失败：', error);
			}
			return host;
		}

		/*
		 * 点注释正文 = 把光标放进去 = 立刻还原成源码。
		 *
		 * 所以除链接以外的鼠标事件都交回 CodeMirror（返回 false），它会把光标落到
		 * 被替换的区间里，装饰随之消失，用户就能直接编辑了。链接要留给浏览器跳转，
		 * 返回 true 让 widget 自己吃事件。
		 */
		ignoreEvent(event) {
			const target = event?.target;
			return target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('a') !== null;
		}
	}

	/**
	 * 扫描 + 过滤 + 建装饰。
	 *
	 * 只有「独占整行」且与选区不相交的注释会被替换；其余照常显示源码。
	 */
	/* 每次光标移动都会重建装饰，这里按 doc 身份缓存整篇文本（doc 不可变，变了就是新对象）。 */
	let cachedDoc = null;
	let cachedText = '';
	let cachedHasDoc = false;
	function textOf(doc) {
		if (doc !== cachedDoc) {
			cachedDoc = doc;
			cachedText = doc.toString();
			cachedHasDoc = cachedText.includes('/--') || cachedText.includes('/-!');
		}
		return cachedText;
	}

	function buildDecorations(state, enabled) {
		if (!enabled) return Decoration.none;
		const text = textOf(state.doc);
		/* 没有文档注释时直接返回，省掉整篇扫描。 */
		if (!cachedHasDoc) return Decoration.none;
		const ranges = [];
		for (const block of renderableBlocks(text, state.selection.ranges)) {
			ranges.push(
				Decoration.replace({ block: true, widget: new DocCommentWidget(block.body, block.kind) }).range(block.from, block.to)
			);
		}
		return Decoration.set(ranges, true);
	}

	/*
	 * block 装饰只能由 state 侧提供（见文件头注释）。这个 field 在三种情况下重建：
	 * 文档变了、选区变了（光标进出注释要还原源码）、渲染开关被切换。
	 */
	const decorationsField = StateField.define({
		create: (state) => buildDecorations(state, true),
		update(value, transaction) {
			const enabled = transaction.state.field(enabledField);
			const toggled = enabled !== transaction.startState.field(enabledField);
			const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
			if (!transaction.docChanged && !selectionChanged && !toggled) return value;
			return buildDecorations(transaction.state, enabled);
		},
		provide: (field) => EditorView.decorations.from(field),
	});

	return { extension: [enabledField, decorationsField], setEnabled, enabledField, decorationsField };
}
