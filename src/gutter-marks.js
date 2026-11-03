// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 行号栏左侧的「证明已完成」对勾。
//
// 来源与 vscode-lean4 完全一致：Lean 服务器在 `textDocument/publishDiagnostics`
// 里给「目标已全部解决」的声明挂一条 `leanTags: [2]`（GoalsAccomplished）的
// 信息级诊断，位置就是声明的首行。它平时不显示（`isSilent`），只用来做装饰。
//
// 我们把它变成行号栏左边的一列对勾：每个被证明完成的声明一行。

// 对勾图标（16x16，实心路径，`currentColor` 让主题控制颜色）是从 vscode-lean4 抄来的
// Apache-2.0 素材，因此放在 `third-party/goals-accomplished-icon.js` 里单独授权——
// MPL-2.0 是逐文件的 copyleft，两种条款不能混在同一个文件里。
import { PROVEN_ICON } from './third-party/goals-accomplished-icon.js';

/*
 * 「正在处理」：一个左半实心的圆盘。
 *
 * 不用 `◐` 字符（gutter 缺字会变方框，理由同对勾），也不做动画 —— 这一列每 100 ms
 * 可能重画一次，动画只会让 CPU 白转；半满的圆本身已经能表达「进行到一半」。
 */
export const BUSY_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
	+ '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.55"/>'
	+ '<path d="M8 2.5 A5.5 5.5 0 0 0 8 13.5 Z" fill="currentColor" opacity="0.85"/></svg>';

/**
 * @param kit - `globalThis.DCM`。
 * @returns `{ extension, setLines }`；`setLines` 接收行号数组，或 `{line, kind}` 数组
 *   （`kind` 省略 = `'proven'`，另一值是 `'busy'`）。
 */
export function createProvenMarks(kit) {
	const { StateEffect, StateField, RangeSet, GutterMarker, gutter } = kit;

	/*
	 * 用内联 SVG 画对勾，而不是字符 `✓`：gutter 的字体会跟着编辑器的等宽字体走，
	 * 缺字时那个码位会渲染成方框（tofu），看起来像故障。
	 */
	class Mark extends GutterMarker {
		constructor(svg, className, title) {
			super();
			this.svg = svg;
			this.className = className;
			this.title = title;
		}

		toDOM() {
			const element = document.createElement('span');
			element.className = this.className;
			element.title = this.title;
			element.innerHTML = this.svg;
			return element;
		}
	}

	/* 共享实例就够了：GutterMarker 无状态，CodeMirror 只拿它当图章。 */
	const proven = new Mark(PROVEN_ICON, 'dle-proven', '证明完成：没有遗留目标');
	const busy = new Mark(BUSY_ICON, 'dle-proven dle-proven-busy', 'Lean 正在处理这一段');
	const setLines = StateEffect.define();

	const normalize = (value, doc) => {
		const seen = new Map();
		for (const entry of Array.isArray(value) ? value : []) {
			const line = Number.isInteger(entry) ? entry : Number(entry?.line);
			if (!Number.isInteger(line) || line < 0 || line >= doc.lines) continue;
			const kind = Number.isInteger(entry) || entry?.kind === undefined ? 'proven' : String(entry.kind);
			/* 同一行同时「处理中」和「已证明」时，「处理中」优先：它才是当下的状态。 */
			const previous = seen.get(line);
			if (previous === 'busy') continue;
			seen.set(line, kind === 'busy' ? 'busy' : 'proven');
		}
		return [...seen.entries()]
			.sort((left, right) => left[0] - right[0])
			.map(([line, kind]) => ({ line, kind }));
	};

	const field = StateField.define({
		create: () => RangeSet.empty,
		update(value, transaction) {
			let next = value.map(transaction.changes);
			for (const effect of transaction.effects) {
				if (!effect.is(setLines)) continue;
				const doc = transaction.state.doc;
				const marks = normalize(effect.value, doc);
				next = RangeSet.of(
					marks.map((entry) => (entry.kind === 'busy' ? busy : proven).range(doc.line(entry.line + 1).from)),
					true
				);
			}
			return next;
		}
	});

	const extension = [
		field,
		gutter({
			class: 'dle-proven-gutter',
			markers: (view) => view.state.field(field),
			/* 先占位，避免第一条标记出现时整列宽度跳变。 */
			initialSpacer: () => proven
		})
	];

	return { extension, setLines, field };
}

/** 从一条诊断里读「目标已解决」标记。Lean 用 `leanTags: [2]` 表示它。 */
export function isGoalsAccomplished(diagnostic) {
	const tags = diagnostic?.leanTags;
	return Array.isArray(tags) && tags.some((tag) => Number(tag) === 2);
}

/**
 * 把一版诊断折成「哪些行需要打对勾」。
 *
 * 同一行可能有多条（增量下发），用 Set 去重即可。
 */
export function accomplishedLines(diagnostics) {
	const list = Array.isArray(diagnostics) ? diagnostics : [];
	const lines = new Set();
	for (const item of list) {
		if (!isGoalsAccomplished(item)) continue;
		const line = Number(item?.startLine);
		if (Number.isInteger(line) && line >= 0) lines.add(line);
	}
	return [...lines].sort((left, right) => left - right);
}

/**
 * 文件进度里「这一行还在算」的那些行。
 *
 * Lean 的 `$/lean/fileProgress` 推的是 `{range, kind}` 列表；`kind` 0 是 Processing、
 * 1 是 Snapshot（已经算完的中间态）。只取 0：Snapshot 的行马上就会有诊断，
 * 先打一个「处理中」再秒删只会闪。
 */
export function processingLines(processing) {
	const lines = new Set();
	for (const item of Array.isArray(processing) ? processing : []) {
		if (Number(item?.kind) !== 0) continue;
		const start = Number(item?.startLine);
		const end = Number.isInteger(item?.endLine) ? Number(item.endLine) : start;
		if (!Number.isInteger(start) || start < 0) continue;
		/* 进度区间可能横跨几十行（一个大 region），全打满会把 gutter 涂成一片。 */
		const stop = Math.min(end, start + 2);
		for (let line = start; line <= stop; line += 1) lines.add(line);
	}
	return [...lines].sort((left, right) => left - right);
}

/**
 * 任务列的最终标记：证明完成（✓）与正在处理（◐）合在一起，同行以「处理中」优先。
 *
 * 错误/警告不在这里 —— 它们在 `lintGutter` 那一列，两列各管一件事，
 * 一列全包会让「这个 ✓ 到底表示什么」变糊。
 */
export function taskMarks(diagnostics, processing) {
	const marks = new Map();
	for (const line of accomplishedLines(diagnostics)) marks.set(line, 'proven');
	for (const line of processingLines(processing)) marks.set(line, 'busy');
	return [...marks.entries()]
		.sort((left, right) => left[0] - right[0])
		.map(([line, kind]) => ({ line, kind }));
}
