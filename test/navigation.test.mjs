// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 跳转与大纲的纯逻辑：路径怎么显示、行号怎么换算、本文件/别的文件怎么分、怎么筛。
//
// 钉住的风险：「行号对外 1 基」这条约定在整个插件里只在这一处被翻译，
// 如果这里算错，用户看到的每个跳转位置都会差一行。

import assert from 'node:assert/strict';
import {
	shortPath,
	formatLocation,
	splitLocations,
	outlineRows,
	filterSymbols
} from '../src/navigation.js';

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

const ROOT = 'D:\\deepseek-harness\\plugin-engineering';
const FILE = `${ROOT}\\001.lean`;

test('shortPath 去掉项目根前缀，并把反斜杠换成正斜杠', () => {
	assert.equal(shortPath(FILE, ROOT), '001.lean');
	assert.equal(shortPath(`${ROOT}\\Demo\\Tree.lean`, ROOT), 'Demo/Tree.lean');
});

test('shortPath 根带结尾斜杠也能匹配', () => {
	assert.equal(shortPath(FILE, `${ROOT}\\`), '001.lean');
});

test('shortPath 不相关的路径退回文件名', () => {
	assert.equal(shortPath('D:\\other\\Foo.lean', ROOT), 'Foo.lean');
});

test('shortPath 对空值与空根不抛错', () => {
	assert.equal(shortPath(undefined, ROOT), '(未知文件)');
	assert.equal(shortPath('', ROOT), '(未知文件)');
	assert.equal(shortPath(FILE, ''), '001.lean');
	assert.equal(shortPath(FILE, undefined), '001.lean');
});

test('formatLocation 把 0 基行列显示成 1 基', () => {
	const location = { path: FILE, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
	assert.equal(formatLocation(location, ROOT), '001.lean:1:1');
});

test('formatLocation 的中间位置换算正确', () => {
	const location = { path: FILE, range: { start: { line: 11, character: 4 } } };
	assert.equal(formatLocation(location, ROOT), '001.lean:12:5');
});

test('formatLocation 对缺字段的对象退回 1:1 而不是 NaN', () => {
	assert.equal(formatLocation(null, ROOT), '(未知文件):1:1');
	assert.equal(formatLocation({ path: FILE }, ROOT), '001.lean:1:1');
});

test('splitLocations 按当前文件切开，并保持原顺序', () => {
	const list = [
		{ path: FILE, range: { start: { line: 0 } } },
		{ path: 'D:\\other\\A.lean', range: { start: { line: 3 } } },
		{ path: FILE, range: { start: { line: 7 } } }
	];
	const { local, external } = splitLocations(list, FILE);
	assert.deepEqual(local.map((item) => item.range.start.line), [0, 7]);
	assert.deepEqual(external.map((item) => item.path), ['D:\\other\\A.lean']);
});

test('splitLocations 丢掉没有 range 的脏条目', () => {
	const { local, external } = splitLocations([null, { path: FILE }, { path: FILE, range: {} }], FILE);
	assert.equal(local.length + external.length, 1);
});

test('splitLocations 对非数组输入返回两个空数组', () => {
	assert.deepEqual(splitLocations(undefined, FILE), { local: [], external: [] });
});

test('outlineRows 给容器里的符号加一层缩进', () => {
	const rows = outlineRows([
		{ name: 'double', kind: 'Function', range: { start: { line: 3 } }, container: '' },
		{ name: 'size', kind: 'Function', range: { start: { line: 40 } }, container: 'Demo.Tree' }
	]);
	assert.deepEqual(rows.map((row) => [row.name, row.depth, row.line]), [['double', 0, 3], ['size', 1, 40]]);
	assert.equal(rows[1].hint, 'Demo.Tree');
});

test('outlineRows 丢掉没有名字的条目，缺 line 时按 0 处理', () => {
	const rows = outlineRows([{ name: '' }, null, { name: 'x' }]);
	assert.deepEqual(rows.map((row) => [row.name, row.line]), [['x', 0]]);
});

test('outlineRows 对非数组输入返回空数组', () => {
	assert.deepEqual(outlineRows(null), []);
});

test('filterSymbols 命中名字或容器，大小写不敏感', () => {
	const list = [
		{ name: 'toList', container: 'Demo.Tree' },
		{ name: 'add_zero', container: '' },
		{ name: 'mapTree', container: 'Demo' }
	];
	assert.deepEqual(filterSymbols(list, 'tree').map((item) => item.name), ['toList', 'mapTree']);
	assert.deepEqual(filterSymbols(list, 'ADD').map((item) => item.name), ['add_zero']);
	assert.deepEqual(filterSymbols(list, '  ').length, 3, '空查询返回全部');
	assert.deepEqual(filterSymbols(list, 'zzz'), []);
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
console.log(`navigation: ${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;
