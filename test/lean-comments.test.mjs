// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 文档注释扫描器 + 「证明完成」标记的纯逻辑测试。
//
// 这两块都在编辑器每次光标移动时跑，逻辑简单但边界多（字符串里的 `/-`、嵌套块
// 注释、未闭合、缩进剥离），所以用最笨的办法逐个钉住。

import assert from 'node:assert/strict';
import { collectDocComments, isRenderable, renderableBlocks } from '../src/lean-comments.js';
import { accomplishedLines, isGoalsAccomplished } from '../src/gutter-marks.js';

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

test('文档注释：单行 /-- 被识别，body 去掉标记', () => {
	const text = '/-- 中序遍历。 -/';
	const items = collectDocComments(text);
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, 'doc');
	assert.equal(items[0].closed, true);
	assert.equal(items[0].body, '中序遍历。');
	assert.equal(items[0].from, 0);
	assert.equal(items[0].to, text.length);
});

test('模块注释：/-! 记为 module', () => {
	const items = collectDocComments('/-! # 标题\n\n正文 -/');
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, 'module');
	assert.equal(items[0].body, '# 标题\n\n正文');
});

test('普通块注释与行注释不算文档注释', () => {
	assert.deepEqual(collectDocComments('/- 普通 -/'), []);
	assert.deepEqual(collectDocComments('-- 行注释 /- 不是块注释 -/\ndef a := 1'), []);
});

test('嵌套块注释：内层 -/ 不提前收尾', () => {
	const text = '/-- 外 /- 内 -/ 尾 -/';
	const items = collectDocComments(text);
	assert.equal(items.length, 1);
	assert.equal(items[0].to, text.length);
	assert.ok(items[0].body.includes('外'));
	assert.ok(items[0].body.includes('尾'));
});

test('未闭合的文档注释标记 closed=false 且不可渲染', () => {
	const items = collectDocComments('/-- 没写完\ndef a := 1');
	assert.equal(items.length, 1);
	assert.equal(items[0].closed, false);
	assert.equal(isRenderable(items[0]), false);
});

test('字符串里的 /-- 不算注释', () => {
	const text = 'def s := "/-- 不是注释 -/"';
	assert.deepEqual(collectDocComments(text), []);
});

test('字符字面量不会打乱扫描', () => {
	const text = "def c := '/'\n/-- 文档 -/";
	const items = collectDocComments(text);
	assert.equal(items.length, 1);
	assert.equal(items[0].body, '文档');
});

test('字符偏移与行号', () => {
	const text = 'def a := 1\n/-- d -/\n';
	const items = collectDocComments(text);
	assert.equal(items.length, 1);
	assert.equal(items[0].from, 11);
	assert.equal(items[0].to, 19);
	assert.equal(items[0].startLine, 1);
	assert.equal(items[0].endLine, 1);
});

test('多行注释的行号覆盖首尾行', () => {
	const text = 'def a := 1\n/-- 一\n二\n三 -/\ndef b := 2';
	const items = collectDocComments(text);
	assert.equal(items.length, 1);
	assert.equal(items[0].startLine, 1);
	assert.equal(items[0].endLine, 3);
	assert.equal(items[0].body, '一\n二\n三');
});

test('缩进剥离：多行体按最小缩进去掉公共前缀', () => {
	const text = '/-- 摘要\n    def 里的代码\n    再一行 -/';
	const items = collectDocComments(text);
	assert.equal(items[0].body, '摘要\ndef 里的代码\n再一行');
});

test('首行紧贴标记时不受最小缩进影响', () => {
	const text = '  /-- 单行 -/';
	const items = collectDocComments(text);
	assert.equal(items[0].body, '单行');
});

test('空白体不可渲染', () => {
	const items = collectDocComments('/--   -/');
	assert.equal(items.length, 1);
	assert.equal(isRenderable(items[0]), false);
	assert.equal(isRenderable(null), false);
});

test('多个注释按出现顺序返回', () => {
	const items = collectDocComments('/-- a -/\ndef x := 1\n/-! b -/');
	assert.deepEqual(items.map((item) => item.kind), ['doc', 'module']);
	assert.deepEqual(items.map((item) => item.body), ['a', 'b']);
});

test('空输入不炸', () => {
	assert.deepEqual(collectDocComments(''), []);
	assert.deepEqual(collectDocComments(undefined), []);
	assert.deepEqual(collectDocComments(null), []);
});

test('GoalsAccomplished：leanTags 含 2 才算', () => {
	assert.equal(isGoalsAccomplished({ leanTags: [2] }), true);
	assert.equal(isGoalsAccomplished({ leanTags: [1] }), false);
	assert.equal(isGoalsAccomplished({ leanTags: [] }), false);
	assert.equal(isGoalsAccomplished({}), false);
	assert.equal(isGoalsAccomplished(null), false);
});

test('accomplishedLines：去重、排序、丢掉脏行号', () => {
	const lines = accomplishedLines([
		{ leanTags: [2], startLine: 7 },
		{ leanTags: [2], startLine: 3 },
		{ leanTags: [2], startLine: 7 },
		{ leanTags: [1], startLine: 4 },
		{ leanTags: [2], startLine: -1 },
		{ leanTags: [2], startLine: 'x' },
		{ startLine: 9 }
	]);
	assert.deepEqual(lines, [3, 7]);
	assert.deepEqual(accomplishedLines(null), []);
	assert.deepEqual(accomplishedLines([{ leanTags: [2], startLine: 1.5 }]), []);
});

test('renderableBlocks：独占整行的注释扩张到整行且不含换行', () => {
	const text = 'def a := 1\n/-- 文档 -/\ndef b := 2';
	const blocks = renderableBlocks(text, []);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].body, '文档');
	assert.equal(text.slice(blocks[0].from, blocks[0].to), '/-- 文档 -/');
});

test('renderableBlocks：多行注释扩张覆盖全部行', () => {
	const text = 'def a := 1\n/-- 一\n二 -/\ndef b := 2';
	const blocks = renderableBlocks(text, []);
	assert.equal(blocks.length, 1);
	assert.equal(text.slice(blocks[0].from, blocks[0].to), '/-- 一\n二 -/');
	assert.equal(blocks[0].line, 1);
	assert.equal(blocks[0].endLine, 2);
});

test('renderableBlocks：注释前后还有代码就跳过', () => {
	assert.deepEqual(renderableBlocks('theorem x := /-- 内联 -/ 1', []), []);
	assert.deepEqual(renderableBlocks('/-- 内联 -/ theorem x := 1', []), []);
});

test('renderableBlocks：光标在注释里时不渲染', () => {
	const text = 'def a := 1\n/-- 文档 -/';
	const inside = text.indexOf('/--') + 3;
	assert.equal(renderableBlocks(text, [{ from: inside, to: inside }]).length, 0);
	assert.equal(renderableBlocks(text, [{ from: 0, to: 0 }]).length, 1);
});

test('renderableBlocks：未闭合与空白体不渲染', () => {
	assert.deepEqual(renderableBlocks('/-- 未闭合', []), []);
	assert.deepEqual(renderableBlocks('/--   -/', []), []);
});

test('renderableBlocks：多个注释按顺序返回', () => {
	const text = '/-- 一 -/\ndef a := 1\n/-! 二 -/\ndef b := 2';
	const blocks = renderableBlocks(text, []);
	assert.deepEqual(blocks.map((block) => block.body), ['一', '二']);
	assert.deepEqual(blocks.map((block) => block.kind), ['doc', 'module']);
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
