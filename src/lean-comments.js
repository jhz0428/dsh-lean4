// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 找出 Lean 源码里的「文档注释」，供编辑器把它们渲染成 markdown。
//
// Lean 4 有两类会被工具链当 markdown 处理的注释：
//   /-- … -/   挂在声明上的文档注释（hover 里看到的就是它）
//   /-! … -/   模块/章节注释（Lean 官方 literate 风格）
// 普通块注释 `/- … -/` 与行注释 `-- …` 不在此列：它们一般是给人看的随手笔记，
// 渲染出来反而是噪音。
//
// 这里只做词法扫描，不建 AST：扫描器必须足够笨、足够快，因为编辑器每次光标移动
// 都要拿它跑一遍整篇文档。

/** 文档注释的开头三个字符。 */
const DOC_OPEN = '/--';
/** 模块注释的开头三个字符。 */
const MODULE_OPEN = '/-!';

/**
 * 跳过一段字符串字面量。
 *
 * Lean 的普通字符串不能跨行，遇到换行就当作未闭合，直接停在换行处——这样
 * 后面即使有 `/-` 也还能被当成注释处理（乐观恢复比整篇放弃好）。
 */
function skipString(source, start) {
	let index = start + 1;
	while (index < source.length) {
		const ch = source[index];
		if (ch === '\\') {
			index += 2;
			continue;
		}
		if (ch === '"') return index + 1;
		if (ch === '\n') return index;
		index += 1;
	}
	return source.length;
}

/** 跳过字符字面量 `'a'` / `'\n'`；`'` 也可能是标识符的一部分（`foo'`），那就只前进一格。 */
function skipChar(source, start) {
	const next = source[start + 1];
	if (next === '\\') {
		const close = source.indexOf("'", start + 2);
		return close === -1 ? start + 1 : close + 1;
	}
	if (source[start + 2] === "'") return start + 3;
	return start + 1;
}

/**
 * 从注释开头往后找 `-/`，并把嵌套的 `/- … -/` 算进去。
 *
 * @param from - 注释开头 `/-` 之后的位置。
 * @returns 收尾 `-/` 中 `-` 的下标；没有收尾返回 -1。
 */
function findBlockEnd(source, from) {
	let depth = 1;
	let index = from;
	while (index < source.length) {
		const ch = source[index];
		if (ch === '"') {
			index = skipString(source, index);
			continue;
		}
		if (ch === '/' && source[index + 1] === '-') {
			depth += 1;
			index += 2;
			continue;
		}
		if (ch === '-' && source[index + 1] === '/') {
			depth -= 1;
			if (depth === 0) return index;
			index += 2;
			continue;
		}
		index += 1;
	}
	return -1;
}

/** 每行的起始下标（用于把字符偏移翻译成行号）。 */
function lineStartsOf(source) {
	const starts = [0];
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] === '\n') starts.push(index + 1);
	}
	return starts;
}

/** 二分找 `offset` 所在行（0 基）。 */
function lineAt(lineStarts, offset) {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (lineStarts[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return low;
}

/**
 * 去掉注释体的公共缩进与首尾空行。
 *
 * 首行紧跟在 `/--` 后面，本来就没有缩进，所以它不参与「最小缩进」的计算，
 * 否则 `  /-- 中序遍历。 -/` 这种单行注释会被削掉一个字符。
 */
function dedent(body) {
	let lines = body.split('\n');
	while (lines.length > 0 && lines[0].trim() === '') lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
	if (lines.length === 0) return '';

	const head = lines[0].trim() === '' ? 0 : 1;
	/* 收尾 `-/` 前面那个空格属于标记，不属于内容：先统一去掉行尾空白。 */
	lines = lines.map((line) => line.replace(/[ \t]+$/, ''));
	lines[0] = lines[0].replace(/^[ \t]+/, '');
	let indent = Number.POSITIVE_INFINITY;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === '') continue;
		const match = lines[index].match(/^[ \t]*/);
		indent = Math.min(indent, match === null ? 0 : match[0].length);
	}
	if (!Number.isFinite(indent)) indent = 0;
	for (let index = head; index < lines.length; index += 1) {
		lines[index] = lines[index].slice(Math.min(indent, lines[index].length));
	}
	return lines.join('\n');
}

/**
 * 扫描一篇 Lean 源码里的文档注释。
 *
 * @param text - 整篇源码。
 * @returns `{ from, to, kind, closed, body, startLine, endLine }[]`，按出现顺序排列。
 *   `from`/`to` 是整段注释（含 `/--` 与 `-/`）的字符区间，`to` 不含。
 */
export function collectDocComments(text) {
	const source = typeof text === 'string' ? text : '';
	const lineStarts = lineStartsOf(source);
	const items = [];
	let index = 0;
	while (index < source.length) {
		const ch = source[index];
		if (ch === '"') {
			index = skipString(source, index);
			continue;
		}
		if (ch === "'") {
			index = skipChar(source, index);
			continue;
		}
		/* 行注释：整行跳过，避免把里面的 `/-` 当块注释开头。 */
		if (ch === '-' && source[index + 1] === '-') {
			const newline = source.indexOf('\n', index);
			index = newline === -1 ? source.length : newline + 1;
			continue;
		}
		if (ch === '/' && source[index + 1] === '-') {
			const marker = source.slice(index, index + 3);
			const kind = marker === DOC_OPEN ? 'doc' : marker === MODULE_OPEN ? 'module' : 'block';
			const end = findBlockEnd(source, index + 2);
			if (end === -1) {
				if (kind !== 'block') {
					items.push(makeItem(source, lineStarts, index, source.length, kind, false));
				}
				break;
			}
			if (kind !== 'block') {
				items.push(makeItem(source, lineStarts, index, end + 2, kind, true));
			}
			index = end + 2;
			continue;
		}
		index += 1;
	}
	return items;
}

function makeItem(source, lineStarts, start, end, kind, closed) {
	const openLength = 3;
	const closeLength = closed ? 2 : 0;
	const body = source.slice(start + openLength, Math.max(start + openLength, end - closeLength));
	return {
		from: start,
		to: end,
		kind,
		closed,
		body: dedent(body),
		startLine: lineAt(lineStarts, start),
		endLine: lineAt(lineStarts, Math.max(start, end - 1))
	};
}

/** 把注释体当成「可以渲染」的判据：有内容、且不是纯空白。 */
export function isRenderable(item) {
	return item !== null && item !== undefined && item.closed === true && item.body.trim() !== '';
}

/** 选区（`{from, to}` 偏移）与一段区间是否相交。 */
function overlaps(selections, from, to) {
	for (const range of selections) {
		if (range.to > from && range.from < to) return true;
	}
	return false;
}

/**
 * 挑出「可以就地替换成渲染块」的注释。
 *
 * 三条规则：
 *   1. 必须独占整行——注释所在行前面不能有代码，收尾 `-/` 后面也不能有代码，
 *      否则替换整行会把代码一起藏起来。
 *   2. 与选区相交的不渲染（光标在里面时要能编辑源码）。
 *   3. 返回的区间已经扩张到整行（不含行尾换行），调用方直接拿它做 block 装饰。
 *
 * @param text - 整篇源码。
 * @param selections - `{from, to}[]`，缺省表示没有选区。
 * @returns `{ from, to, body, kind, line, endLine }[]`。
 */
export function renderableBlocks(text, selections) {
	const source = typeof text === 'string' ? text : '';
	const ranges = Array.isArray(selections) ? selections : [];
	const blocks = [];
	for (const item of collectDocComments(source)) {
		if (!isRenderable(item)) continue;
		const lineStart = source.lastIndexOf('\n', Math.max(0, item.from - 1)) + 1;
		if (source.slice(lineStart, item.from).trim() !== '') continue;
		const nextNewline = source.indexOf('\n', item.to);
		const lineEnd = nextNewline === -1 ? source.length : nextNewline;
		if (source.slice(item.to, lineEnd).trim() !== '') continue;
		if (overlaps(ranges, lineStart, lineEnd)) continue;
		blocks.push({
			from: lineStart,
			to: lineEnd,
			body: item.body,
			kind: item.kind,
			line: item.startLine,
			endLine: item.endLine
		});
	}
	return blocks;
}
