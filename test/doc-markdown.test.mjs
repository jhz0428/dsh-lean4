// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 注释渲染那一层真正跑起来的行为：用真的 @codemirror/state + view 建一个
// EditorState，验证「整行注释被替换、光标进去就还原、开关能关掉」。
//
// 这条测试是为了钉住一个真机上炸过的问题：早先用 ViewPlugin 提供 block 装饰，
// CodeMirror 会抛 `Block decorations may not be specified via plugins`，
// 整个编辑器直接白掉。纯文本测试看不出这个，只有真的建 state 才能。

import assert from 'node:assert/strict';
import * as stateKit from '@codemirror/state';
import * as viewKit from '@codemirror/view';
import { createDocMarkdown } from '../src/doc-markdown.js';

const kit = {
	Decoration: viewKit.Decoration,
	WidgetType: viewKit.WidgetType,
	EditorView: viewKit.EditorView,
	StateEffect: stateKit.StateEffect,
	StateField: stateKit.StateField,
};

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

function makeState(doc, selection) {
	const module = createDocMarkdown(kit);
	const extensions = [module.extension];
	if (Number.isInteger(selection)) {
		extensions.push(stateKit.EditorState.allowMultipleSelections.of(false));
	}
	const state = stateKit.EditorState.create({
		doc,
		selection: Number.isInteger(selection) ? { anchor: selection } : undefined,
		extensions,
	});
	return { state, module };
}

function sizeOf(state, module) {
	return state.field(module.decorationsField).size;
}

test('block 装饰来自 StateField：建 state 不抛错且能拿到装饰', () => {
	const { state, module } = makeState('def a := 1\n/-- 文档 -/\ndef b := 2');
	assert.equal(sizeOf(state, module), 1);
});

test('独占整行的注释被替换成一个 block 装饰', () => {
	const { state, module } = makeState('/-- 一 -/\n/-- 二 -/');
	assert.equal(sizeOf(state, module), 2);
	assert.equal(state.facet(viewKit.EditorView.decorations).length, 1);
});

test('多行文档注释算一个装饰（不是每行一个）', () => {
	const { state, module } = makeState('/-- 一\n二\n三 -/');
	assert.equal(sizeOf(state, module), 1);
});

test('光标进入注释后还原成源码', () => {
	const doc = 'def a := 1\n/-- 文档 -/\ndef b := 2';
	const { state, module } = makeState(doc);
	assert.equal(sizeOf(state, module), 1);
	const inside = doc.indexOf('/--') + 4;
	const after = state.update({ selection: { anchor: inside } }).state;
	assert.equal(sizeOf(after, module), 0);
});

test('光标离开注释后又渲染回来', () => {
	const doc = 'def a := 1\n/-- 文档 -/\ndef b := 2';
	const { state, module } = makeState(doc);
	const inside = doc.indexOf('/--') + 4;
	const moved = state.update({ selection: { anchor: inside } }).state;
	assert.equal(sizeOf(moved, module), 0);
	const back = moved.update({ selection: { anchor: 0 } }).state;
	assert.equal(sizeOf(back, module), 1);
});

test('开关能关掉渲染，也能再打开', () => {
	const { state, module } = makeState('/-- 文档 -/');
	const off = state.update({ effects: module.setEnabled.of(false) }).state;
	assert.equal(off.field(module.enabledField), false);
	assert.equal(sizeOf(off, module), 0);
	const on = off.update({ effects: module.setEnabled.of(true) }).state;
	assert.equal(sizeOf(on, module), 1);
});

test('编辑文档后装饰跟着重算', () => {
	const { state, module } = makeState('def a := 1');
	assert.equal(sizeOf(state, module), 0);
	const inserted = state.update({ changes: { from: 0, insert: '/-- 新 -/\n' } }).state;
	assert.equal(sizeOf(inserted, module), 1);
});

test('夹在代码里的注释不渲染', () => {
	const { state, module } = makeState('theorem x := /-- 内联 -/ 1');
	assert.equal(sizeOf(state, module), 0);
});

test('没有注释的文件不产生任何 block 装饰', () => {
	const { state, module } = makeState('def a := 1\ndef b := 2');
	assert.equal(sizeOf(state, module), 0);
});

test('块 widget 给出高度估值，不再按一行算', () => {
	const { state, module } = makeState('def a := 1\n/-- 一\n二\n三 -/\ndef b := 2');
	const decos = state.field(module.decorationsField);
	let widget = null;
	decos.between(0, state.doc.length, (_from, _to, deco) => {
		widget = deco.spec.widget;
	});
	assert.ok(widget, '应该有块装饰');
	assert.ok(widget.estimatedHeight >= 5, '估值必须 >= 5，否则 CodeMirror 会当它不够高、退回按行估');
	assert.equal(widget.estimatedHeight, Math.max(24, Math.round(3 * 19.5) + 30));
});

test('单行注释也有合理估值（不是 -1）', () => {
	const { state, module } = makeState('/-- 一 -/');
	const decos = state.field(module.decorationsField);
	let widget = null;
	decos.between(0, state.doc.length, (_from, _to, deco) => {
		widget = deco.spec.widget;
	});
	assert.equal(widget.estimatedHeight, Math.max(24, Math.round(19.5) + 30));
});

let failed = 0;
for (const { name, fn } of cases) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL ${name}`);
		console.error(error instanceof Error ? error.stack : error);
	}
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
