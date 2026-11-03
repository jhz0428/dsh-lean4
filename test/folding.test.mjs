// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 折叠：纯函数（区间归一化、证明段识别）+ 用真的 @codemirror/state 验证 foldService
// 与 foldEffect 的接线。
//
// 为什么要有真 state 那一层：`foldService` 是 Facet，`foldEffect` 是 StateEffectType，
// 两者接错（比如把数组当函数调用、或者 forgot `.of()`）都不会报错，只会「折叠箭头
// 永远不出现」。纯函数测试完全看不出这种问题。
//
// 关键事实（tools/probe-folding.mjs 实测）：Lean 的 FoldingRange.kind 只有
// comment / imports / region，**从不发 proof** —— 所以「折叠证明」只能靠行首关键字。

import assert from 'node:assert/strict';
import * as stateKit from '@codemirror/state';
import * as viewKit from '@codemirror/view';
import * as languageKit from '@codemirror/language';
import {
	PROOF_START,
	normalizeFoldingRanges,
	foldingRangeIndex,
	proofRangesOf,
	createFolding,
	foldProofs
} from '../src/folding.js';

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
	EditorView: viewKit.EditorView,
	foldService: languageKit.foldService,
	foldable: languageKit.foldable,
	foldEffect: languageKit.foldEffect,
	foldGutter: languageKit.foldGutter,
	foldKeymap: languageKit.foldKeymap,
	codeFolding: languageKit.codeFolding,
	foldedRanges: languageKit.foldedRanges,
	keymap: viewKit.keymap
};

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

const LINES = [
	'theorem foo (a : Nat) : a = a := by',
	'  rfl',
	'',
	'@[simp] lemma bar : 1 = 1 := by decide',
	'def x := 1',
	'private noncomputable theorem baz : True := by',
	'  trivial',
	'  trivial'
].join('\n');

test('PROOF_START 认 theorem / lemma / example，不认 def', () => {
	assert.equal(PROOF_START.test('theorem t : True := trivial'), true);
	assert.equal(PROOF_START.test('lemma t : True := trivial'), true);
	assert.equal(PROOF_START.test('example : True := trivial'), true);
	assert.equal(PROOF_START.test('def f := 1'), false);
	assert.equal(PROOF_START.test('  theorem indented'), false, '行首有空格就不算声明开头');
});

test('PROOF_START 允许属性与修饰符前缀', () => {
	assert.equal(PROOF_START.test('@[simp] lemma bar : 1 = 1 := rfl'), true);
	assert.equal(PROOF_START.test('@[simp, norm_cast] theorem bar : 1 = 1 := rfl'), true);
	assert.equal(PROOF_START.test('private noncomputable theorem baz : True := trivial'), true);
	assert.equal(PROOF_START.test('local instance : Inhabited Nat := ⟨0⟩'), false);
});

test('normalizeFoldingRanges 丢掉单行、越界与非整数', () => {
	const ranges = normalizeFoldingRanges([
		{ startLine: 0, endLine: 0 },
		{ startLine: 1, endLine: 2 },
		{ startLine: 9, endLine: 12 },
		{ startLine: 'x', endLine: 3 },
		null,
		{ startLine: -1, endLine: 5 }
	], 6);
	assert.deepEqual(ranges, [{ startLine: 1, endLine: 2, kind: '' }]);
});

test('normalizeFoldingRanges 夹到文档末尾后可能塌成单行，也要丢掉', () => {
	// 老文件有 20 行、新文件只剩 6 行：5..9 夹成 5..5，没有可折叠内容。
	const ranges = normalizeFoldingRanges([{ startLine: 5, endLine: 9 }], 6);
	assert.deepEqual(ranges, []);
});

test('normalizeFoldingRanges 保留 kind 并按起始行排序', () => {
	const ranges = normalizeFoldingRanges([
		{ startLine: 8, endLine: 10, kind: 'region' },
		{ startLine: 2, endLine: 5, kind: 'comment' }
	]);
	assert.deepEqual(ranges.map((item) => item.startLine), [2, 8]);
	assert.equal(ranges[0].kind, 'comment');
});

test('foldingRangeIndex 同一行取更长的那个区间', () => {
	const index = foldingRangeIndex([
		{ startLine: 3, endLine: 5 },
		{ startLine: 3, endLine: 12 }
	]);
	assert.equal(index.get(3).endLine, 12);
});

test('proofRangesOf 只挑「行首是证明 + 服务器给了区间」的行', () => {
	const ranges = normalizeFoldingRanges([
		{ startLine: 0, endLine: 2 },
		{ startLine: 3, endLine: 3 },
		{ startLine: 5, endLine: 7 }
	]);
	const proofs = proofRangesOf(LINES.split('\n'), ranges);
	// 0..2 是 theorem；3 行是单行 lemma（无区间，跳过）；5..7 是 private noncomputable theorem。
	assert.deepEqual(proofs, [{ startLine: 0, endLine: 2 }, { startLine: 5, endLine: 7 }]);
});

test('proofRangesOf 对空输入不抛错', () => {
	assert.deepEqual(proofRangesOf([], []), []);
	assert.deepEqual(proofRangesOf(undefined, undefined), []);
});

test('createFolding 的 extension 里含 field / foldService / 折叠槽', () => {
	const folding = createFolding(kit);
	assert.ok(Array.isArray(folding.extension));
	assert.ok(folding.extension.length >= 4);
	assert.equal(typeof folding.setRanges?.of, 'function', 'setRanges 必须是 StateEffectType，不是函数');
});

test('apply 写进去的区间能被 foldable() 读到', () => {
	const folding = createFolding(kit);
	const state = stateKit.EditorState.create({
		doc: LINES,
		extensions: [folding.extension]
	});
	const withRanges = state.update({ effects: folding.setRanges.of(normalizeFoldingRanges([
		{ startLine: 0, endLine: 2 }
	])) }).state;
	const hit = languageKit.foldable(withRanges, withRanges.doc.line(1).from, withRanges.doc.line(1).to);
	assert.ok(hit !== null, '第 1 行应该可折叠');
	assert.equal(hit.from, withRanges.doc.line(1).from);
	assert.equal(hit.to, withRanges.doc.line(3).to);
	// 第 2 行不是区间起点，不可折叠。
	assert.equal(languageKit.foldable(withRanges, withRanges.doc.line(2).from, withRanges.doc.line(2).to), null);
});

test('没有区间时 foldable() 返回 null（不会误画折叠箭头）', () => {
	const folding = createFolding(kit);
	const state = stateKit.EditorState.create({ doc: LINES, extensions: [folding.extension] });
	assert.equal(languageKit.foldable(state, state.doc.line(1).from, state.doc.line(1).to), null);
});

test('apply 之后 rangesOf 能读回，且行数变化时区间仍按旧行号（由 foldService 夹住）', () => {
	const folding = createFolding(kit);
	const state = stateKit.EditorState.create({ doc: LINES, extensions: [folding.extension] });
	const withRanges = state.update({ effects: folding.setRanges.of(normalizeFoldingRanges([
		{ startLine: 0, endLine: 2 },
		{ startLine: 5, endLine: 7 }
	])) }).state;
	assert.deepEqual(folding.rangesOf(withRanges).map((item) => item.startLine), [0, 5]);
});

void foldProofs;
void viewKit;

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
console.log(`folding: ${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;
