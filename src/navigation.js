// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 跳转与大纲的纯逻辑。
//
// 我们的编辑器只打开一个文件，所以「跳转」分两种情况：
//   本文件   → 直接把光标挪过去（`local`）
//   别的文件 → 只能显示路径与行列，让用户自己开（`external`）
// 这两种在 UI 上必须区分开，否则点了没反应会被当成 bug。

/**
 * 把文件路径压成「从项目根算起」的相对路径，用于展示。
 *
 * 只是给人看的：不做 `..` 之外的路径规范化（Windows 上大小写、长路径都能把
 * 一个正经的规范化逻辑搞复杂），算不出来就退回文件名。
 */
export function shortPath(path, root) {
	if (typeof path !== 'string' || path === '') return '(未知文件)';
	const normalized = path.replace(/\\/g, '/');
	if (typeof root !== 'string' || root === '') {
		const cut = normalized.lastIndexOf('/');
		return cut < 0 ? normalized : normalized.slice(cut + 1);
	}
	const base = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
	if (normalized.startsWith(base)) return normalized.slice(base.length);
	const cut = normalized.lastIndexOf('/');
	return cut < 0 ? normalized : normalized.slice(cut + 1);
}

/**
 * 位置 → 一行可读文字：`Foo.lean:12:5`。
 *
 * 行号列号对外一律 **1 基**（编辑器里看到的、编译器报的、用户数的都是 1 基），
 * 只有 LSP 传输层是 0 基。
 */
export function formatLocation(location, root) {
	const label = shortPath(location?.path, root);
	const line = Number.isInteger(location?.range?.start?.line) ? location.range.start.line + 1 : 1;
	const character = Number.isInteger(location?.range?.start?.character) ? location.range.start.character + 1 : 1;
	return `${label}:${line}:${character}`;
}

/**
 * 把一组 `Location` 按「在不在当前文件」切开。
 *
 * 顺序保持原样：Lean 的 `references` 是有意义的顺序（定义在前、使用按位置排），
 * 按本地/外部重排会打乱阅读节奏。
 */
export function splitLocations(list, currentPath) {
	const local = [];
	const external = [];
	for (const item of Array.isArray(list) ? list : []) {
		if (item === null || typeof item !== 'object' || item.range === undefined) continue;
		if (item.path === currentPath) local.push(item);
		else external.push(item);
	}
	return { local, external };
}

/**
 * 大纲：把宿主拍平的符号列表变成带缩进的行。
 *
 * 宿主给的 `container` 是符号所属的命名空间/结构体名（`Demo.Tree.size` 的话就是
 * `Demo.Tree`），用它算缩进比递归建树简单得多，而且我们只需要「显示 + 点击跳转」。
 */
export function outlineRows(symbols) {
	const rows = [];
	for (const item of Array.isArray(symbols) ? symbols : []) {
		if (item === null || typeof item !== 'object') continue;
		const name = typeof item.name === 'string' ? item.name : '';
		if (name === '') continue;
		const container = typeof item.container === 'string' ? item.container : '';
		const line = Number.isInteger(item.range?.start?.line) ? item.range.start.line : 0;
		rows.push({
			name,
			container,
			line,
			/* 只有一层缩进：`container` 是拍平时的扁平前缀，嵌套深度已经丢了。 */
			depth: container === '' ? 0 : 1,
			label: name,
			hint: container,
			kind: typeof item.kind === 'string' ? item.kind : '',
		});
	}
	return rows;
}

/**
 * 大纲里筛符号。
 *
 * 大小写不敏感的子串匹配 —— Lean 的名字是 `camelCase` 与 `snake_case` 混着来的，
 * 前缀匹配会让「找 map 相关」这种查询直接零结果。
 */
export function filterSymbols(list, query) {
	const rows = Array.isArray(list) ? list : [];
	const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
	if (needle === '') return rows;
	return rows.filter((item) => {
		const name = typeof item?.name === 'string' ? item.name.toLowerCase() : '';
		const container = typeof item?.container === 'string' ? item.container.toLowerCase() : '';
		return name.includes(needle) || container.includes(needle);
	});
}
