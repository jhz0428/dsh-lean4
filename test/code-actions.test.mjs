// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 「建议」面板的排序与筛选：哪条该排前面、这条能不能就地应用、当前行有哪些诊断。
//
// 钉住的风险：Lean 的 `exact?` 只发 quickfix，但如果排序把「没有 edit 的 action」
// 排在前面，用户点「应用」会毫无反应 —— 所以 `isApplicable` 与 `rankCodeActions`
// 必须一致地看待「有没有可落地编辑」。

import assert from 'node:assert/strict';
import {
	rankCodeActions,
	editsForPath,
	isApplicable,
	describeAction,
	diagnosticsOnLine
} from '../src/code-actions.js';

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

const PATH = 'D:/proj/Foo.lean';

function action(title, extra = {}) {
	return { title, kind: 'quickfix', isPreferred: false, edit: null, ...extra };
}

function editFor(path, newText, line = 1) {
	return {
		changes: [{
			uri: `file:///${path}`,
			path,
			range: { start: { line, character: 2 }, end: { line, character: 6 } },
			newText
		}]
	};
}

test('rankCodeActions 把 isPreferred 排最前', () => {
	const list = rankCodeActions([
		action('B'),
		action('A', { isPreferred: true })
	]);
	assert.deepEqual(list.map((item) => item.title), ['A', 'B']);
});

test('rankCodeActions 让带编辑的 quickfix 排在无编辑的普通 action 之前', () => {
	const list = rankCodeActions([
		action('无编辑', { kind: 'refactor' }),
		action('有编辑', { edit: editFor(PATH, 'exact h') })
	]);
	assert.deepEqual(list.map((item) => item.title), ['有编辑', '无编辑']);
});

test('rankCodeActions 同权重时保持服务器给的顺序（稳定排序）', () => {
	const list = rankCodeActions([action('一'), action('二'), action('三')]);
	assert.deepEqual(list.map((item) => item.title), ['一', '二', '三']);
});

test('rankCodeActions 丢掉没有 title 的脏条目', () => {
	const list = rankCodeActions([null, { kind: 'quickfix' }, action('好的')]);
	assert.deepEqual(list.map((item) => item.title), ['好的']);
});

test('rankCodeActions 对非数组输入返回空数组', () => {
	assert.deepEqual(rankCodeActions(undefined), []);
	assert.deepEqual(rankCodeActions('x'), []);
});

test('editsForPath 只取落在我这份文档上的编辑', () => {
	const item = action('t', {
		edit: {
			changes: [
				{ path: PATH, range: { start: { line: 1 }, end: { line: 1 } }, newText: 'mine' },
				{ path: 'D:/proj/Other.lean', range: { start: { line: 1 }, end: { line: 1 } }, newText: 'other' }
			]
		}
	});
	assert.deepEqual(editsForPath(item, PATH).map((one) => one.newText), ['mine']);
});

test('editsForPath 允许 path 字段缺失（只有 uri 的情况）', () => {
	const item = action('t', {
		edit: { changes: [{ uri: 'file:///x.lean', range: { start: { line: 0 }, end: { line: 0 } }, newText: 'x' }] }
	});
	assert.equal(editsForPath(item, PATH).length, 1);
});

test('editsForPath 丢掉没有 newText 或没有 range 的条目', () => {
	const item = action('t', {
		edit: { changes: [{ path: PATH, newText: 'no range' }, { path: PATH, range: { start: { line: 0 } } }] }
	});
	assert.deepEqual(editsForPath(item, PATH), []);
});

test('editsForPath 对没有 edit 的 action 返回空数组', () => {
	assert.deepEqual(editsForPath(action('t'), PATH), []);
	assert.deepEqual(editsForPath(null, PATH), []);
});

test('isApplicable 与 editsForPath 同步', () => {
	assert.equal(isApplicable(action('t', { edit: editFor(PATH, 'x') }), PATH), true);
	assert.equal(isApplicable(action('t', { edit: editFor('D:/other/y.lean', 'x') }), PATH), false);
	assert.equal(isApplicable(action('t'), PATH), false);
});

test('describeAction 给出编辑条数与可用性', () => {
	const described = describeAction(action('Try this', { edit: editFor(PATH, 'x'), isPreferred: true }));
	assert.equal(described.title, 'Try this');
	assert.equal(described.edits, 1);
	assert.equal(described.applicable, true);
	assert.equal(described.kind, 'quickfix');
});

test('describeAction 对空 action 不抛错', () => {
	assert.deepEqual(describeAction(null), { title: '', edits: 0, applicable: false, kind: '' });
});

test('diagnosticsOnLine 只留与目标行相交的诊断', () => {
	const list = [
		{ message: 'a', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } } },
		{ message: 'b', range: { start: { line: 5, character: 0 }, end: { line: 8, character: 0 } } },
		{ message: 'c', range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }
	];
	assert.deepEqual(diagnosticsOnLine(list, 3).map((item) => item.message), ['a']);
	assert.deepEqual(diagnosticsOnLine(list, 6).map((item) => item.message), ['b'], '跨行诊断在中间行也算命中');
	assert.deepEqual(diagnosticsOnLine(list, 9).map((item) => item.message), []);
});

test('diagnosticsOnLine 对缺 end 的诊断按单行处理', () => {
	const list = [{ message: 'a', range: { start: { line: 2 } } }];
	assert.deepEqual(diagnosticsOnLine(list, 2).length, 1);
	assert.deepEqual(diagnosticsOnLine(list, 3).length, 0);
});

test('diagnosticsOnLine 对非数组输入返回空数组', () => {
	assert.deepEqual(diagnosticsOnLine(undefined, 1), []);
});

let failed = 0;
for (const item of cases) {
	try {
		item.fn();
		console.log(`  ok  ${item.name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${item.name}`);
		console.log(`       ${error.message}`);
	}
}
console.log(`code-actions: ${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;
