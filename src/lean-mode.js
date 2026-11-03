// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Lean 4 分词器：一个纯 `StreamLanguage` spec 对象，不依赖 CodeMirror。
//
// 为什么手写：`@codemirror/lang-*` 与 `@codemirror/legacy-modes` 都没有 Lean 语法。
// 逐行状态机够用——Lean 里唯一跨行的构造是可嵌套的块注释。
//
// 覆盖：`--` 行注释、可嵌套且跨行的 `/- … -/`、带转义的字符串与字符字面量、
// 十进制/十六进制/二进制/浮点、`def` 族的声明关键字、声明名、大写开头的类型名、
// 运算符。
//
// 刻意不覆盖：完整的 Lean 符号表（`⟨⟩`/`·`/`≫` 只认一部分）、属性载荷、任何需要
// 真正解析的东西。分词器不是解析器；不认识的符号「不上色」比「猜一个」诚实。
//
// 发出的 tag 只取主题真正上色的那几个（见 editor.js 的 HighlightStyle）：
// comment / keyword / string / number / atom / typeName /
// variableName.function / operator / invalid。

/**
 * Lean 标识符：ASCII 字母、数字、`_`，加上 Lean 允许的 `'`、`!`、`?` 后缀
 * （`h'`、`foo!`、`beq?`）。Unicode 字母在 Lean 里到处都是（`α`、`h₁`），由第二个
 * 分支匹配。
 */
const IDENTIFIER = /^(?:[A-Za-z_][A-Za-z0-9_'!?]*|[^\x00-\x7F][^\s(){}\[\],;:"']*)/;

/** 十进制、十六进制（`0xFF`）、二进制（`0b1010`）、浮点与指数。 */
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/;

/** 声明关键字：其后紧跟的标识符就是被定义的名字（`def foo`）。 */
const DEFINING_KEYWORDS = new Set([
	'def', 'theorem', 'lemma', 'example', 'axiom', 'inductive', 'structure', 'class',
	'instance', 'abbrev', 'opaque', 'syntax', 'macro', 'notation', 'attribute'
]);

/** 关键字词汇表：控制流、声明修饰符、绑定子。 */
const KEYWORDS = new Set([
	'namespace', 'section', 'end', 'open', 'import', 'export', 'universe', 'variable',
	'variables', 'parameter', 'parameters', 'mutual', 'where', 'deriving', 'extends',
	'private', 'protected', 'noncomputable', 'unsafe', 'partial', 'local', 'scoped',
	'infix', 'infixl', 'infixr', 'prefix', 'postfix', 'elab', 'initialize',
	'fun', 'let', 'in', 'have', 'show', 'from', 'by', 'at', 'with', 'do', 'if', 'then',
	'else', 'match', 'return', 'unless', 'for', 'obtain', 'suffices', 'calc', 'this',
	// `Prop` / `Type` / `Sort` 故意不在这里：它们和其它类型名一样首字母大写，
	// 由同一条规则上色，一个判断只留在一处。
	'forall', 'exists', 'λ', '∀', '∃', 'rfl',
	'simp', 'omega', 'ring', 'norm_num', 'decide', 'trivial', 'exact', 'apply',
	'intro', 'intros', 'constructor', 'refine', 'assumption', 'contradiction',
	'subst', 'rw', 'unfold', 'specialize', 'revert', 'clear', 'induction', 'cases'
]);

/**
 * 消费一段块注释。
 *
 * 逐字符走，因为嵌套计数必须看见每一个 `/-` 与 `-/`，而它们都是两个字符、可能
 * 跨过边界——从剩余串上读才诚实。
 */
function readBlockComment(stream, state) {
	while (!stream.eol()) {
		const rest = stream.string.slice(stream.pos);
		if (rest.startsWith('-/')) {
			stream.pos += 2;
			state.commentDepth -= 1;
			if (state.commentDepth <= 0) {
				state.commentDepth = 0;
				break;
			}
			continue;
		}
		if (rest.startsWith('/-')) {
			stream.pos += 2;
			state.commentDepth += 1;
			continue;
		}
		stream.next();
	}
	return 'comment';
}

/**
 * 消费一个字符串字面量。Lean 字符串不能跨行，所以这里从不留下状态：跑到行尾就是
 * `invalid`，下一行重新开始。
 */
function readString(stream) {
	stream.next();
	for (;;) {
		const char = stream.next();
		if (char === undefined || char === null) return 'invalid';
		if (char === '\\') {
			const escaped = stream.next();
			if (escaped === undefined || escaped === null) return 'invalid';
			continue;
		}
		if (char === '"') return 'string';
	}
}

/** 按 Lean 自己的命名约定判断一个名字是不是类型。 */
function looksLikeType(name) {
	const last = name.split('.').pop() ?? name;
	return last.length > 0 && last[0] === last[0].toUpperCase() && last[0] !== last[0].toLowerCase();
}

/**
 * 交给 `StreamLanguage.define` 的 spec。
 *
 * 跨行状态只有块注释深度：Lean 块注释可嵌套且合法地跨行；字符串不进来——那是一个
 * 真实的 bug（一个漏掉的引号会把后面整篇吞成字符串）。
 */
export const LEAN_SPEC = {
	name: 'lean',

	startState() {
		return { commentDepth: 0, expectDefinitionName: false };
	},

	/** 检查点拷贝，编辑器只是快照、从不持有活对象，浅拷贝就是全部要求。 */
	copyState(state) {
		return { ...state };
	},

	/** 块注释里的空行不能丢深度计数器。 */
	blankLine() {},

	token(stream, state) {
		// 先恢复上一行留下的构造。顺序有讲究：注释优先于字符串，因为一个打开着的
		// 字符串里的 `/-` 并不是注释，不能先恢复它。
		if (state.commentDepth > 0) return readBlockComment(stream, state);

		if (stream.eatSpace()) return null;

		const char = stream.peek();
		if (char === undefined || char === null) return null;

		// `--` 行注释。放在块注释之前，两者否则会在开头的连字符上抢。
		if (char === '-' && stream.string.startsWith('--', stream.pos)) {
			stream.pos = stream.string.length;
			return 'comment';
		}
		if (char === '/' && stream.string.startsWith('/-', stream.pos)) {
			// 深度从 ZERO 开始，不是 1：readBlockComment 会自己走过开括号。
			// 曾经在这里种成 1，结果每个块注释都多算一层、把注释之后那一行也吞掉。
			state.commentDepth = 0;
			state.expectDefinitionName = false;
			return readBlockComment(stream, state);
		}
		if (char === '"') {
			state.expectDefinitionName = false;
			return readString(stream);
		}
		// 字符字面量 `'a'`。不在 token 开头的 `'` 属于标识符，到不了这里。
		if (char === "'") {
			state.expectDefinitionName = false;
			stream.next();
			for (;;) {
				const next = stream.next();
				if (next === undefined || next === null) return 'string';
				if (next === '\\') stream.next();
				else if (next === "'") break;
			}
			return 'string';
		}
		if (char >= '0' && char <= '9') {
			state.expectDefinitionName = false;
			const matched = NUMBER.exec(stream.string.slice(stream.pos));
			if (matched !== null) {
				stream.pos += matched[0].length;
				return 'number';
			}
			stream.next();
			return 'number';
		}

		const identifier = IDENTIFIER.exec(stream.string.slice(stream.pos));
		if (identifier !== null) {
			const name = identifier[0];
			stream.pos += name.length;
			// 声明名是紧跟在 `def` 族关键字之后的标识符；其余普通名字不上色。
			if (state.expectDefinitionName) {
				state.expectDefinitionName = false;
				return 'variableName.function';
			}
			if (DEFINING_KEYWORDS.has(name) || KEYWORDS.has(name)) {
				state.expectDefinitionName = DEFINING_KEYWORDS.has(name);
				return 'keyword';
			}
			return looksLikeType(name) ? 'typeName' : null;
		}

		// 运算符与标点整段消费，好让 `:=` 与 `=>` 是一个 token 而不是冒号加一个散字符。
		state.expectDefinitionName = false;
		const operator = /^(?::=|=>|->|<-|:=|::|[|:;,.(){}\[\]@=<>+*/\\!&^-]+)/.exec(stream.string.slice(stream.pos));
		const text = operator === null ? stream.next() ?? '' : operator[0];
		if (operator !== null) stream.pos += text.length;
		return 'operator';
	}
};
