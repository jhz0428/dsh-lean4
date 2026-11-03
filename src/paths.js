// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * 把查看器给的 `path` 变成绝对路径。
 *
 * 为什么需要：better-sidebar 的 `FileViewerProps.path` 不保证是绝对路径 ——
 * 从会话文件树点开的文件常常是「相对会话工作目录」的（例如
 * `施工方案/PlanSpec.lean`），而保存接口能自己按 sessionId 补上基准，
 * LSP 这边却把它原样交给宿主半。宿主半只能拿 `process.cwd()` 去拼，
 * 于是 `D:\proj\施工方案\PlanSpec.lean` 被读成
 * `C:\Users\…\profiles\desktop\施工方案\PlanSpec.lean` —— 目录不存在，
 * `lean --server` 起不来，浏览器每 4 秒一次的 pull 又不停地重建，
 * 表现就是「切到某些文件 Lean 崩溃、并且一直重启失败」（2026-11-03 定位）。
 *
 * 这个模块只做路径算术，不碰 DOM、不碰 cordis，所以能在 Node 里单测。
 */

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^\\\\/;
const TRAILING_SEPARATORS = /[\\/]+$/;
const LEADING_SEPARATORS = /^[\\/]+/;

/**
 * `value` 是不是绝对路径。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAbsolutePath(value) {
	if (typeof value !== 'string' || value === '') return false;
	if (UNC_PREFIX.test(value)) return true;
	if (WINDOWS_ABSOLUTE.test(value)) return true;
	return value.startsWith('/');
}

/**
 * 一个基准路径该用哪种分隔符：Windows 风格（含 `\` 且没有 `/`）用 `\`，其余用 `/`。
 *
 * @param {unknown} base
 * @returns {string}
 */
export function separatorOf(base) {
	if (typeof base !== 'string' || base === '') return '/';
	if (base.includes('\\') && !base.includes('/')) return '\\';
	return '/';
}

/**
 * 把相对路径接到基准后面，分隔符统一成基准的风格。
 *
 * 只处理「基准 + 相对」这一种形状：`..` 不折叠（基准由会话 cwd 给出，正常不会带 `..`；
 * 真要折叠得知道盘符与工作目录，属于 Node 的 `path` 而不是浏览器该干的事）。
 *
 * @param {string} base
 * @param {string} relative
 * @returns {string}
 */
export function joinPath(base, relative) {
	const sep = separatorOf(base);
	const head = typeof base === 'string' ? base.replace(TRAILING_SEPARATORS, '') : '';
	const tail = relative.replace(LEADING_SEPARATORS, '');
	if (head === '') return tail;
	return head + sep + tail.split(/[\\/]/).join(sep);
}

/**
 * `value` 是绝对路径就原样返回，否则接到 `base` 后面。
 *
 * 拿不到基准（`base` 为空/不是字符串）时原样返回 —— 宁可让上层报
 * 「找不到文件」，也不要猜一个可能更错的位置。
 *
 * @param {unknown} base
 * @param {unknown} value
 * @returns {unknown}
 */
export function absolutePathOf(base, value) {
	if (typeof value !== 'string' || value === '') return value;
	if (isAbsolutePath(value)) return value;
	if (typeof base !== 'string' || base === '') return value;
	return joinPath(base, value);
}

/**
 * 会话工作目录：DSH 把每个会话的 cwd 存在会话列表里，better-sidebar 自己也用它
 * 解析 `a/b.c` 这类文件地址，所以这里取同一个来源。
 *
 * @param {any} ctx
 * @param {unknown} sessionId
 * @returns {string | undefined}
 */
export function sessionCwdOf(ctx, sessionId) {
	if (typeof sessionId !== 'string' || sessionId === '') return undefined;
	try {
		const cwd = ctx?.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd;
		return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
	} catch {
		/* 没有会话列表（精简宿主、测试桩）时退回调用方自己的基准。 */
		return undefined;
	}
}

/**
 * 查看器路径 + 会话上下文 → 绝对路径。
 *
 * @param {any} ctx
 * @param {unknown} sessionId
 * @param {unknown} value
 * @returns {unknown}
 */
export function viewerPathOf(ctx, sessionId, value) {
	return absolutePathOf(sessionCwdOf(ctx, sessionId), value);
}
