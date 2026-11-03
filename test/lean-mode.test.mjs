// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Lean 分词器的契约测试：纯 Node，不碰 DOM、不碰 CodeMirror。
//
// 断言的是「tag 序列」而不是「颜色」——颜色是主题的事，分词器的唯一责任是把每个
// 字符段归到正确的 tag 上。tag 名必须落在 editor.js 的 HighlightStyle 里写到的集合
// 内，否则上了色也看不见。

import { LEAN_SPEC } from '../src/lean-mode.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const failures = [];

function check(name, run) {
	try {
		run();
		passed += 1;
	} catch (error) {
		failures.push(`${name}: ${error.message}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${message}\n  实际: ${a}\n  期望: ${b}`);
}

/** CodeMirror `StringStream` 的最小替身：只实现 Spec 真正会用到的几个方法。 */
function streamOf(text) {
	return {
		string: text,
		pos: 0,
		eol() {
			return this.pos >= this.string.length;
		},
		next() {
			if (this.pos >= this.string.length) return undefined;
			this.pos += 1;
			return this.string[this.pos - 1];
		},
		peek() {
			return this.pos >= this.string.length ? undefined : this.string[this.pos];
		},
		eatSpace() {
			const start = this.pos;
			while (this.pos < this.string.length && /\s/.test(this.string[this.pos])) this.pos += 1;
			return this.pos > start;
		}
	};
}

/**
 * 跑一行，返回 `[{ tag, text }]`。
 *
 * `token()` 被反复调用直到行尾——这正是 CodeMirror 的做法，所以这里也借此验证
 * 「一定会前进」这个不变量。
 */
function tokenizeLine(text, state) {
	const stream = streamOf(text);
	const out = [];
	let guard = 0;
	while (!stream.eol()) {
		guard += 1;
		if (guard > text.length * 4 + 16) throw new Error(`token() 没有前进：${JSON.stringify(text)}`);
		const before = stream.pos;
		const tag = LEAN_SPEC.token(stream, state);
		if (stream.pos <= before && !stream.eol()) throw new Error(`token() 在 ${before} 处空转`);
		out.push({ tag, text: text.slice(before, stream.pos) });
	}
	return out;
}

function tagsOf(lines) {
	const state = LEAN_SPEC.startState();
	const rows = lines.map((line) => tokenizeLine(line, state));
	return { state, rows };
}

/**
 * 去掉空白段。
 *
 * `token()` 遇到空格会 `eatSpace()` 再返回 `null`（CodeMirror 的约定：null 表示
 * 「这段不着色，继续」），所以原始序列里每个词之间都夹着一个 null 段。断言关心的
 * 是有 tag 的那些。
 */
function significant(segments) {
	return segments.filter((segment) => segment.tag !== null);
}

const ALLOWED = new Set([
	'comment', 'keyword', 'string', 'number', 'typeName',
	'variableName.function', 'operator', 'invalid', null
]);

check('声明关键字后的名字是 variableName.function', () => {
	const { rows } = tagsOf(['def double (n : Nat) : Nat := 2 * n']);
	assertEqual(significant(rows[0]).slice(0, 2), [
		{ tag: 'keyword', text: 'def' },
		{ tag: 'variableName.function', text: 'double' }
	], 'def 与紧随其后的名字');
	assert(rows[0].some((segment) => segment.tag === 'number'), '数字应被认出');
	assert(rows[0].some((segment) => segment.tag === 'operator'), ':= 应被认出');
});

check('theorem 同样触发定义名', () => {
	const { rows } = tagsOf(['theorem add_zero (n : Nat) : n + 0 = n := rfl']);
	const segments = significant(rows[0]);
	assertEqual(segments[0], { tag: 'keyword', text: 'theorem' }, 'theorem');
	assertEqual(segments[1], { tag: 'variableName.function', text: 'add_zero' }, '定理名');
});

check('大写开头的名字是类型', () => {
	const { rows } = tagsOf(['def f : Nat := 1']);
	const nat = rows[0].find((segment) => segment.text === 'Nat');
	assert(nat !== undefined, '应切出 Nat');
	assertEqual(nat.tag, 'typeName', 'Nat 的类型 tag');
});

check('Prop / Type / Sort 走类型而不是关键字', () => {
	const { rows } = tagsOf(['def p : Prop := True']);
	const types = rows[0].filter((segment) => segment.tag === 'typeName').map((segment) => segment.text);
	assert(types.includes('Prop'), 'Prop 应为 typeName');
});

check('字符串连同转义一起是一个 token', () => {
	const { rows } = tagsOf(['def g := s!"Hello, {name}!"']);
	const literal = rows[0].filter((segment) => segment.tag === 'string').map((segment) => segment.text).join('');
	assert(literal.includes('Hello'), '字符串内容应被纳入');
});

check('未闭合字符串是 invalid，且不污染下一行', () => {
	const { state, rows } = tagsOf(['def a := "unterminated', 'def b := 1']);
	const last = rows[0][rows[0].length - 1];
	assertEqual(last.tag, 'invalid', '行尾未闭合的字符串');
	assertEqual(state.commentDepth, 0, '字符串不应留下跨行状态');
	assert(rows[1].some((segment) => segment.tag === 'keyword' && segment.text === 'def'), '下一行仍应正常分词');
	assert(!rows[1].some((segment) => segment.tag === 'invalid'), '下一行不应有 invalid');
});

check('字符字面量是 string', () => {
	const { rows } = tagsOf(["def c := 'a'"]);
	assert(rows[0].some((segment) => segment.tag === 'string' && segment.text === "'a'"), "应认出 'a'");
});

check('行注释吃掉行尾', () => {
	const { rows } = tagsOf(['def x := 1 -- 注释 def']);
	const comment = rows[0][rows[0].length - 1];
	assertEqual(comment.tag, 'comment', '行注释');
	assert(comment.text.endsWith('def'), '注释里的 def 不应再被当关键字');
	assert(!rows[0].slice(0, -1).some((segment) => segment.tag === 'keyword' && segment.text === 'def' && segment !== rows[0][0]), '注释外的 def 只有首个');
});

check('块注释跨行保持状态', () => {
	const { state, rows } = tagsOf(['/- one', '   two -/', 'def v := 1']);
	assertEqual(rows[0].map((segment) => segment.tag), ['comment'], '第一行整行注释');
	assertEqual(rows[1].map((segment) => segment.tag), ['comment'], '第二行整行注释');
	assertEqual(state.commentDepth, 0, '闭合后深度归零');
	assertEqual(rows[2][0], { tag: 'keyword', text: 'def' }, '注释结束后恢复');
});

check('嵌套块注释计数正确，且不吞掉后一行', () => {
	const { state, rows } = tagsOf(['/- a /- b -/ c -/', 'def w := 4']);
	assertEqual(state.commentDepth, 0, '嵌套两层闭合后深度归零');
	assertEqual(rows[1][0], { tag: 'keyword', text: 'def' }, '后一行必须仍是代码');
	assert(rows[1].some((segment) => segment.tag === 'number'), '后一行的数字仍要认出');
});

check('未闭合块注释吃到文件尾', () => {
	const { state, rows } = tagsOf(['/- open', 'def w := 4', '-/', 'def v := 1']);
	assertEqual(rows[1].map((segment) => segment.tag), ['comment'], '注释体内的 def 仍是注释');
	assertEqual(state.commentDepth, 0, '闭合后归零');
	assertEqual(rows[3][0], { tag: 'keyword', text: 'def' }, '闭合后的下一行恢复代码');
});

check('块注释里的空行不丢深度', () => {
	const state = LEAN_SPEC.startState();
	tokenizeLine('/- a', state);
	LEAN_SPEC.blankLine(state);
	tokenizeLine('', state);
	assertEqual(state.commentDepth, 1, '空行后仍在注释里');
	const rows = tokenizeLine('b -/', state);
	assertEqual(rows, [{ tag: 'comment', text: 'b -/' }], '续行仍是注释');
	assertEqual(state.commentDepth, 0, '闭合');
});

check('copyState 是检查点，不共享活状态', () => {
	const state = LEAN_SPEC.startState();
	tokenizeLine('/- open', state);
	const snapshot = LEAN_SPEC.copyState(state);
	tokenizeLine('-/', state);
	assertEqual(state.commentDepth, 0, '原件已闭合');
	assertEqual(snapshot.commentDepth, 1, '快照保持打开');
	assert(snapshot !== state, '必须是不同对象');
});

check('纯空白不产生任何带 tag 的段', () => {
	const { rows } = tagsOf(['   ']);
	assertEqual(rows[0], [{ tag: null, text: '   ' }], '整行空白只应是一段无色段');
	assertEqual(significant(rows[0]), [], '不应有任何 tag');
});

check('每一段都落在白名单内', () => {
	const source = readFileSync(fileURLToPath(new URL('./fixtures/sample.lean', import.meta.url)), 'utf8');
	const state = LEAN_SPEC.startState();
	const seen = new Set();
	for (const line of source.split(/\r?\n/)) {
		for (const segment of tokenizeLine(line, state)) {
			assert(ALLOWED.has(segment.tag), `出现了未登记的 tag：${segment.tag}（${JSON.stringify(segment.text)}）`);
			seen.add(segment.tag);
		}
	}
	assert(seen.has('comment'), '001.lean 里应有注释');
	assert(seen.has('keyword'), '001.lean 里应有关键字');
	assert(seen.has('variableName.function'), '001.lean 里应有声明名');
	assert(!seen.has('invalid'), '001.lean 里不应出现 invalid');
	assertEqual(state.commentDepth, 0, '读完整个文件不应停在注释里');
});

if (failures.length > 0) {
	console.error(`lean-mode: ${passed} 通过 / ${failures.length} 失败`);
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(`lean-mode: ${passed}/${passed} 通过`);
