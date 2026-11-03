// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 代码折叠：走 Lean 的 `textDocument/foldingRange`，再加一层客户端启发式。
//
// 关键事实（`tools/probe-folding.mjs` 实测，Lean 4.35）：`FoldingRange.kind` 只有
// `comment` / `imports` / `region` 三种，**服务器从不发 `"proof"`**。上游 vscode-lean4
// 的 `isProof = kind === 'proof'`（`src/utils/converters.ts:148-153`）因此永远为假 ——
// 也就是说「折叠所有证明」在 VS Code 里其实也是靠它自己的另一套逻辑兜的。
// 这里改成按行首关键字认证明（`PROOF_START`），实测能命中 `001.lean` 的两个多行定理。
//
// 本文件的纯函数部分可以在 Node 里直接测；`createFolding` 需要 CodeMirror 的 `kit`。

/**
 * 「这一行是不是证明的开头」。
 *
 * 认 `theorem` / `lemma` / `example`，允许前面挂 `@[simp]` 这类属性和
 * `private` / `noncomputable` 之类修饰符。刻意不认 `def`：普通定义也可能很长，
 * 用户折叠它们的诉求远低于折叠证明。
 */
export const PROOF_START = /^(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|partial|unsafe|local)\s+)*(?:theorem|lemma|example)\b/;

/**
 * 把宿主推来的折叠区间收成 `{startLine, endLine, kind}`（全 0 基，行号）。
 *
 * 丢掉 `endLine <= startLine` 的：单行区间没有可折叠的内容，留着只会让
 * `foldService` 返回一个 from == to 的空区间，CodeMirror 会在那儿画一个点不开的箭头。
 */
export function normalizeFoldingRanges(list, lineCount) {
	const out = [];
	for (const item of Array.isArray(list) ? list : []) {
		if (item === null || typeof item !== 'object') continue;
		const startLine = Number(item.startLine);
		const endLine = Number(item.endLine);
		if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) continue;
		if (startLine < 0 || endLine <= startLine) continue;
		if (Number.isInteger(lineCount) && startLine >= lineCount) continue;
		/* 先夹到文档范围内再判一次：夹完可能塌成单行（`5..9` 的文件只有 6 行）。 */
		const clamped = Number.isInteger(lineCount) ? Math.min(endLine, lineCount - 1) : endLine;
		if (clamped <= startLine) continue;
		out.push({
			startLine,
			endLine: clamped,
			kind: typeof item.kind === 'string' ? item.kind : '',
		});
	}
	out.sort((left, right) => left.startLine - right.startLine);
	return out;
}

/** 按起始行建索引，`foldService` 每行都要查一次，线性扫太浪费。 */
export function foldingRangeIndex(ranges) {
	const index = new Map();
	for (const range of Array.isArray(ranges) ? ranges : []) {
		/* 同一行有多个区间时取**最长**的：region 套 comment 时用户想折的是外层。 */
		const known = index.get(range.startLine);
		if (known === undefined || range.endLine > known.endLine) index.set(range.startLine, range);
	}
	return index;
}

/**
 * 从文档里挑出「证明段」：行首命中 `PROOF_START` 且服务器确实为这一行发了折叠区间。
 *
 * 后者是必要的：没有区间说明这一段在 Lean 眼里没有可折叠结构（例如单行定理
 * `theorem t : 2 + 2 = 4 := rfl`），强行折叠会切出半个语法结构。
 */
export function proofRangesOf(lines, ranges) {
	const index = foldingRangeIndex(ranges);
	const out = [];
	const list = Array.isArray(lines) ? lines : [];
	for (let line = 0; line < list.length; line += 1) {
		if (!PROOF_START.test(list[line] ?? '')) continue;
		const hit = index.get(line);
		if (hit === undefined) continue;
		out.push({ startLine: line, endLine: hit.endLine });
	}
	return out;
}

/**
 * 折叠相关的编辑器扩展。
 *
 * 拆成「一个 StateField + 一个 foldService + 折叠槽」是因为 foldService 是**同步**的，
 * 而折叠区间是异步拿到的：服务器回包后 dispatch 一个 effect 写进 field，
 * foldService 再从 field 里读。
 */
export function createFolding(kit) {
	const { StateEffect, StateField, EditorView } = kit;
	const setRanges = StateEffect.define();
	const field = StateField.define({
		create: () => [],
		update(value, transaction) {
			for (const effect of transaction.effects) {
				if (effect.is(setRanges)) return effect.value;
			}
			return value;
		},
	});

	/*
	 * `foldService` 对**每一行**都会被问一次（`foldable` 的调用点），所以这里
	 * 必须 O(1)：索引按区间数组的身份缓存，数组换了才重建。
	 */
	let cachedFor = null;
	let cachedIndex = new Map();

	const service = kit.foldService.of((state, lineStart) => {
		const ranges = state.field(field, false);
		if (ranges === undefined || ranges.length === 0) return null;
		if (cachedFor !== ranges) {
			cachedFor = ranges;
			cachedIndex = foldingRangeIndex(ranges);
		}
		const line = state.doc.lineAt(lineStart);
		const hit = cachedIndex.get(line.number - 1);
		if (hit === undefined) return null;
		const last = state.doc.line(Math.min(hit.endLine + 1, state.doc.lines));
		if (last.to <= line.from) return null;
		return { from: line.from, to: last.to };
	});

	const extension = [
		field,
		service,
		kit.codeFolding({ placeholderText: '⋯' }),
		/* 默认的折叠箭头够用，只改尺寸与颜色；`foldGutter` 自己会处理点击。 */
		kit.foldGutter({ foldGutterClass: 'dle-fold-gutter' }),
		kit.keymap.of(kit.foldKeymap),
		EditorView.theme({
			'.dle-fold-gutter': { width: '14px', color: 'inherit', opacity: '0.75' },
			'.dle-fold-gutter .cm-gutterElement': { cursor: 'pointer' },
		}),
	];

	return {
		extension,
		field,
		setRanges,
		/** 服务器回了新的折叠区间。 */
		apply(view, list) {
			const ranges = normalizeFoldingRanges(list, view.state.doc.lines);
			view.dispatch({ effects: setRanges.of(ranges) });
			return ranges;
		},
		rangesOf(state) {
			return state.field(field, false) ?? [];
		},
	};
}

/**
 * 折叠所有证明。
 *
 * 已经折过的跳过 —— 重复 dispatch 同一个区间时 CodeMirror 会把它当成新的折叠，
 * 撤销栈里会多出一堆空操作，Ctrl+Z 要按好几次才动一下。
 *
 * @returns 这一次真正折起来的段数
 */
export function foldProofs(view, kit, ranges) {
	const folded = kit.foldedRanges(view.state);
	const taken = new Set();
	folded.between(0, view.state.doc.length, (from) => {
		taken.add(view.state.doc.lineAt(from).number - 1);
	});
	const lines = [];
	for (let number = 1; number <= view.state.doc.lines; number += 1) {
		lines.push(view.state.doc.line(number).text);
	}
	const proofs = proofRangesOf(lines, ranges);
	const effects = [];
	for (const proof of proofs) {
		if (taken.has(proof.startLine)) continue;
		const from = view.state.doc.line(proof.startLine + 1).from;
		const to = view.state.doc.line(Math.min(proof.endLine + 1, view.state.doc.lines)).to;
		if (to <= from) continue;
		effects.push(kit.foldEffect.of({ from, to }));
	}
	if (effects.length > 0) view.dispatch({ effects });
	return effects.length;
}

/** 展开全部：走 CodeMirror 自带的 `unfoldAll` 命令。 */
export function unfoldEverywhere(view, kit) {
	kit.unfoldAll(view);
}
