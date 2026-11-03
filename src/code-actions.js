// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 「建议」（Lean 的 `Try this`）的纯逻辑：挑哪条、改哪里、文本是什么。
//
// 数据形状由宿主半 `lean-server.js` 的 `codeActions()` 归一化过：
//   { title, kind, isPreferred, edit: { changes: [{ uri, path, range, newText }] } | null, command }
// 所以这里只做筛选与展示，不碰 LSP 细节，也不碰 CodeMirror。

/**
 * 排一下序，让最该点的排在最前。
 *
 * 顺序：`isPreferred` > `quickfix` > 其它。Lean 对 `exact?` / `apply?` 只发 quickfix，
 * 但它是**唯一**会给出可落地编辑的那种；refactor / source 类目前用不到，排在后面即可。
 */
export function rankCodeActions(list) {
	const weight = (action) => {
		let score = 0;
		if (action.isPreferred === true) score -= 2;
		if (action.kind === 'quickfix') score -= 1;
		if (action.edit !== null && action.edit !== undefined) score -= 1;
		return score;
	};
	return (Array.isArray(list) ? list : [])
		.filter((item) => item !== null && typeof item === 'object' && typeof item.title === 'string' && item.title !== '')
		.map((item, index) => ({ item, index }))
		.sort((left, right) => weight(left.item) - weight(right.item) || left.index - right.index)
		.map((entry) => entry.item);
}

/**
 * 这条 action 会改到哪些文件。
 *
 * `only` 传当前文件路径时，就只有「能就地应用」的 action 会被算进来 —— 我们的编辑器
 * 只能改自己手上这一份文档，跨文件的修改（Lean 的 `rename` 之类）无处落地。
 */
export function editsForPath(action, path) {
	const changes = action?.edit?.changes;
	if (!Array.isArray(changes)) return [];
	return changes.filter((item) => item !== null && typeof item === 'object'
		&& typeof item.newText === 'string'
		&& item.range !== undefined
		&& (path === undefined || item.path === undefined || item.path === path));
}

/** 能就地应用吗：至少有一条落在我这份文档上的编辑。 */
export function isApplicable(action, path) {
	return editsForPath(action, path).length > 0;
}

/**
 * 面板上的一行字。
 *
 * `Try this:\n  [apply] exact h` 这种多行 message 会把面板撑高，压成一行更好读；
 * 标题本身已经够说明了，所以直接用它。
 */
export function describeAction(action) {
	const title = typeof action?.title === 'string' ? action.title : '';
	const edits = Array.isArray(action?.edit?.changes) ? action.edit.changes.length : 0;
	return {
		title,
		edits,
		applicable: edits > 0,
		kind: typeof action?.kind === 'string' ? action.kind : '',
	};
}

/**
 * 从诊断里挑出「同一行、值得问一次 code action」的那些。
 *
 * Lean 的 provider 是按诊断反查 info tree 的，传一条完全不相关的诊断只会白跑一趟；
 * 所以只把**与当前行相交**的传进去（`Try this` 诊断的 range 就是被替换的那一段）。
 */
export function diagnosticsOnLine(diagnostics, line) {
	return (Array.isArray(diagnostics) ? diagnostics : []).filter((item) => {
		const start = item?.range?.start?.line;
		const end = item?.range?.end?.line ?? start;
		return Number.isInteger(start) && Number.isInteger(end) && line >= start && line <= end;
	});
}
