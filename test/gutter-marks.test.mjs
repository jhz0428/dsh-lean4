// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 「证明完成」那一列真正跑起来的行为：用真的 @codemirror/state + view 建 EditorState，
// 验证 setLines 之后 gutter 的 markers facet 能读到标记，且行号 → 位置的换算正确。
//
// 这条测试钉住的是「诊断里明明有 leanTags:[2]，界面上却没有 ✓✓」这类回归：
// 纯函数测试能过，但扩展没接进 state 就什么都不会渲染。

import assert from 'node:assert/strict';
import * as stateKit from '@codemirror/state';
import * as viewKit from '@codemirror/view';
import {
	createProvenMarks,
	accomplishedLines,
	isGoalsAccomplished,
	processingLines,
	taskMarks,
	BUSY_ICON
} from '../src/gutter-marks.js';
// 图标是 Apache-2.0 素材，单独一个文件（不进 MPL-2.0 覆盖范围）。
import { PROVEN_ICON } from '../src/third-party/goals-accomplished-icon.js';

/* toDOM 需要 document；这里只关心 state，给个最小桩就够。 */
if (typeof globalThis.document === 'undefined') {
	globalThis.document = {
		createElement() {
			return { className: '', title: '', innerHTML: '', appendChild() {} };
		}
	};
}

const kit = {
	StateEffect: stateKit.StateEffect,
	StateField: stateKit.StateField,
	RangeSet: stateKit.RangeSet,
	GutterMarker: viewKit.GutterMarker,
	gutter: viewKit.gutter
};

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

const DOC = 'def a := 1\ndef b := 2\ndef c := 3\ndef d := 4\n';

/** 从 state 里取当前所有 gutter 标记所在的行（0 基）。 */
function markedLines(state, field) {
	const marks = state.field(field);
	const lines = [];
	marks.between(0, state.doc.length, (from) => {
		lines.push(state.doc.lineAt(from).number - 1);
	});
	return lines;
}

test('setLines 之后 gutter 标记落在对应行上', () => {
	const module = createProvenMarks(kit);
	const state = stateKit.EditorState.create({ doc: DOC, extensions: module.extension });
	assert.deepEqual(markedLines(state, module.field), []);

	const next = state.update({ effects: module.setLines.of([2, 0]) }).state;
	assert.deepEqual(markedLines(next, module.field), [0, 2], '升序且各一行');
});

test('越界与重复行号被丢掉', () => {
	const module = createProvenMarks(kit);
	const state = stateKit.EditorState.create({ doc: DOC, extensions: module.extension });
	const next = state.update({ effects: module.setLines.of([3, 3, 99, -1, 1.5]) }).state;
	assert.deepEqual(markedLines(next, module.field), [3]);
});

test('文档变长后标记跟着 document 走（不会被裁掉）', () => {
	const module = createProvenMarks(kit);
	let state = stateKit.EditorState.create({ doc: DOC, extensions: module.extension });
	state = state.update({ effects: module.setLines.of([3]) }).state;
	state = state.update({ changes: { from: 0, insert: 'def z := 0\n' } }).state;
	assert.deepEqual(markedLines(state, module.field), [4], '插入一行后标记下移');
});

test('清空 setLines([]) 能撤掉所有标记', () => {
	const module = createProvenMarks(kit);
	let state = stateKit.EditorState.create({ doc: DOC, extensions: module.extension });
	state = state.update({ effects: module.setLines.of([1, 2]) }).state;
	assert.deepEqual(markedLines(state, module.field), [1, 2]);
	state = state.update({ effects: module.setLines.of([]) }).state;
	assert.deepEqual(markedLines(state, module.field), []);
});

test('isGoalsAccomplished 认 2，不认别的', () => {
	assert.equal(isGoalsAccomplished({ leanTags: [2] }), true);
	assert.equal(isGoalsAccomplished({ leanTags: [1] }), false);
	assert.equal(isGoalsAccomplished({ leanTags: [1, 2] }), true);
	assert.equal(isGoalsAccomplished({ leanTags: ['2'] }), true, '字符串也认，服务端偶尔发字符串');
	assert.equal(isGoalsAccomplished({}), false);
	assert.equal(isGoalsAccomplished(null), false);
});

test('accomplishedLines 从诊断里挑出目标已完成的行并去重排序', () => {
	const list = [
		{ startLine: 5, leanTags: [2] },
		{ startLine: 2, leanTags: [1] },
		{ startLine: 5, leanTags: [2] },
		{ startLine: 0, leanTags: [2] }
	];
	assert.deepEqual(accomplishedLines(list), [0, 5]);
});

/*
 * 这个图标被写字面量坑过两次：先是 `✓✓` 字符在缺 U+2713 的等宽字体里渲染成 tofu，
 * 后是自绘双勾的两条 stroke 在 16px 内重叠 1.2 单位、抗锯齿后糊成一个实心方块。
 * 断言几何而不是像素：可见路径必须落在 16x16 的 viewBox 内，且用 fill 而非细 stroke。
 */
test('对勾图标是 16x16 的实心路径，不是会糊成方块的细线', () => {
	assert.match(PROVEN_ICON, /viewBox="0 0 16 16"/, 'viewBox 必须是 16x16');
	assert.match(PROVEN_ICON, /width="16"/);
	assert.match(PROVEN_ICON, /height="16"/);
	assert.match(PROVEN_ICON, /fill="currentColor"/, '颜色跟随主题');
	assert.doesNotMatch(PROVEN_ICON, /stroke=/, '实心路径，不用细 stroke（细线在小尺寸上会糊）');
	assert.equal(PROVEN_ICON.match(/<path/g)?.length, 2, '主体 + 细节两条路径');
});

test('图标路径坐标都落在 viewBox 内（含 translate 偏移）', () => {
	/* 官方 SVG 用 transform="translate(-0.4018,-0.1633)" 把路径挪回框内。 */
	assert.match(PROVEN_ICON, /translate\(-0\.4018449,-0\.16325205\)/);
	const numbers = [...PROVEN_ICON.matchAll(/-?\d+(?:\.\d+)?/g)]
		.map((match) => Number(match[0]))
		.filter((value) => Number.isFinite(value));
	/* 只做粗检：路径里不该出现三位数以上的坐标（那说明复制时漏了小数点）。 */
	const suspicious = numbers.filter((value) => Math.abs(value) > 40);
	assert.deepEqual(suspicious, [], `坐标里出现异常大数：${suspicious.join(', ')}`);
});

/*
 * 「正在处理」与最终标记的合并规则。
 *
 * 钉住的风险：`$/lean/fileProgress` 的区间可以横跨几十行，原样刷满会把整列 gutter
 * 涂成一条，看起来像故障；另外同行既有「处理中」又有「已完成」时必须让处理中赢，
 * 否则用户会看到「已经证明完了」的错觉。
 */
test('processingLines 只取 kind===0，且区间最多刷三行', () => {
	assert.deepEqual(processingLines([{ startLine: 4, endLine: 4, kind: 0 }]), [4]);
	assert.deepEqual(processingLines([{ startLine: 2, endLine: 9, kind: 0 }]), [2, 3, 4], '大区间截到三行');
	assert.deepEqual(processingLines([{ startLine: 2, endLine: 9, kind: 1 }]), [], 'Snapshot 不涂');
});

test('processingLines 丢掉非法行号，并按行号排序', () => {
	assert.deepEqual(processingLines([
		{ startLine: 7, kind: 0 },
		{ startLine: -1, kind: 0 },
		{ startLine: 'x', kind: 0 },
		{ startLine: 3, kind: 0 }
	]), [3, 7]);
	assert.deepEqual(processingLines(undefined), []);
});

test('taskMarks 合并两路，同行以「正在处理」优先', () => {
	const diagnostics = [{ startLine: 5, leanTags: [2], isSilent: true }];
	const marks = taskMarks(diagnostics, [{ startLine: 5, kind: 0 }, { startLine: 9, kind: 0 }]);
	assert.deepEqual(marks, [
		{ line: 5, kind: 'busy' },
		{ line: 9, kind: 'busy' }
	]);
});

test('taskMarks 在没有进度时只给已完成', () => {
	const diagnostics = [
		{ startLine: 1, leanTags: [2], isSilent: true },
		{ startLine: 3, leanTags: [2], isSilent: true }
	];
	assert.deepEqual(taskMarks(diagnostics, []), [
		{ line: 1, kind: 'proven' },
		{ line: 3, kind: 'proven' }
	]);
});

test('taskMarks 对空输入返回空数组', () => {
	assert.deepEqual(taskMarks(undefined, undefined), []);
});

test('忙碌图标同样是 16x16 的 SVG，且带「未画满」的视觉暗示', () => {
	assert.match(BUSY_ICON, /viewBox="0 0 16 16"/);
	assert.match(BUSY_ICON, /fill="currentColor"/);
	assert.match(BUSY_ICON, /opacity=/, '半透明是「进行中」的提示');
	assert.match(BUSY_ICON, /<circle/, '外圈');
});

let failed = 0;
for (const { name, fn } of cases) {
	try {
		fn();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`  FAIL ${name}\n       ${error.message}`);
	}
}
if (failed > 0) {
	console.error(`gutter-marks: ${cases.length - failed}/${cases.length} 通过`);
	process.exit(1);
}
console.log(`gutter-marks: ${cases.length}/${cases.length} 通过`);
