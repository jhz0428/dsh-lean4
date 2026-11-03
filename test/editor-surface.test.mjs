// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * 面板明暗判定的回归测试。
 *
 * 这一条曾经造成两个用户可见的 bug：深色侧边栏里悬停提示是白底、选区是浅灰块。
 * 根因是 `EditorView.theme(..., { dark })` 拿到的 dark 值判错了 —— 只读 `color`
 * 时，DSH 传下来的常常是 `rgba(0, 0, 0, 0)` 或 `inherit`，算不出亮度就当浅色处理。
 */

import { isDarkSurface } from '../src/editor.js';

let failed = 0;
let passed = 0;

function check(name, run) {
	try {
		run();
		passed += 1;
		console.log(`ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${name}`);
		console.log(`     ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertEqual(actual, expected, what) {
	if (actual !== expected) throw new Error(`${what}：期望 ${expected}，实际 ${actual}`);
}

const element = (background, color, parent = null) => ({ __background: background, __color: color, parentElement: parent });

/** 用一个最小的 getComputedStyle 替身驱动被测函数。 */
function withComputedStyle(run) {
	const previous = globalThis.getComputedStyle;
	globalThis.getComputedStyle = (node) => ({ backgroundColor: node.__background, color: node.__color });
	try {
		run();
	} finally {
		globalThis.getComputedStyle = previous;
	}
}

check('祖先链上的深色不透明背景判为深色', () => {
	withComputedStyle(() => {
		const root = element('rgb(20, 20, 24)', 'rgb(220, 220, 220)');
		const middle = element('rgba(0, 0, 0, 0)', 'inherit', root);
		const host = element('rgba(0, 0, 0, 0)', 'inherit', middle);
		assertEqual(isDarkSurface(host), true, '深色');
	});
});

check('祖先链上的浅色不透明背景判为浅色', () => {
	withComputedStyle(() => {
		const root = element('rgb(250, 250, 250)', 'rgb(30, 30, 30)');
		const host = element('rgba(0, 0, 0, 0)', 'inherit', root);
		assertEqual(isDarkSurface(host), false, '浅色');
	});
});

check('半透明背景不算数，继续往上找（极淡的蒙层不能决定明暗）', () => {
	withComputedStyle(() => {
		const root = element('rgb(18, 18, 20)', 'rgb(230, 230, 230)');
		// alpha = 0 的蒙层被跳过，不能因为它的 rgb 是白色就判成浅色。
		const overlay = element('rgba(255, 255, 255, 0)', 'inherit', root);
		assertEqual(isDarkSurface(overlay), true, '跳过透明层');
	});
});

check('一路都没有不透明背景时用文字色兜底', () => {
	withComputedStyle(() => {
		const host = element('rgba(0, 0, 0, 0)', 'rgb(214, 214, 214)');
		assertEqual(isDarkSurface(host), true, '浅字 => 深底');
		const light = element('rgba(0, 0, 0, 0)', 'rgb(32, 32, 32)');
		assertEqual(isDarkSurface(light), false, '深字 => 浅底');
	});
});

check('完全拿不到样式时默认深色（宁可深底，也不要白底浅字）', () => {
	const previous = globalThis.getComputedStyle;
	globalThis.getComputedStyle = () => {
		throw new Error('no layout');
	};
	try {
		assertEqual(isDarkSurface({ parentElement: null }), true, '兜底');
	} finally {
		globalThis.getComputedStyle = previous;
	}
});

console.log(`\neditor-surface: ${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
