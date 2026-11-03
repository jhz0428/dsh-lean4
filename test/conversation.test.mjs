// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 「添加到对话」的纯逻辑：草稿追加、chip 折叠偏移、选区格式化。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	appendOffset,
	appendText,
	appendToComposer,
	describeComposerFailure,
	foldClipboardOffset,
	leadFor,
	selectionBlock
} from '../src/conversation.js';

/** 造一个带 `ctx.get('conversation')` / `ctx.sessions.scope()` 的假 ctx。 */
function fakeCtx({ draft = '', occurrences = [], phase = 'idle', claim, draftRev = 3, noRev = false, refuse = false, throwOn } = {}) {
	const events = [];
	let current = { draft, occurrences, phase, claim, draftRev: noRev ? undefined : draftRev };
	const input = {
		state: { getSnapshot: () => current },
		setDraft(next) {
			if (throwOn === 'setDraft') throw new Error('boom');
			current = { ...current, draft: next, draftRev: current.draftRev + 1 };
		}
	};
	const scope = {
		emit(name, payload) {
			events.push({ name, payload });
			if (throwOn === 'emit') throw new Error('boom');
			if (!refuse) current = { ...current, draftRev: current.draftRev + 1 };
		}
	};
	const ctx = {
		get: (name) => (name === 'conversation' ? { input: { for: () => input } } : undefined),
		sessions: { scope: () => scope }
	};
	return { ctx, events, input, get: () => current };
}

test('appendText 只在缺分隔符时补空格', () => {
	assert.equal(appendText('', 'x'), 'x');
	assert.equal(appendText('a', 'x'), 'a x');
	assert.equal(appendText('a ', 'x'), 'a x');
	assert.equal(appendText('a', ' x'), 'a x');
	assert.equal(leadFor('a'), ' ');
	assert.equal(leadFor('a '), '');
	assert.equal(leadFor(''), '');
});

test('foldClipboardOffset 把 chip 折成 1 个字符', () => {
	// chip 覆盖 [3, 6)（3 个字符），折掉 2 个。
	const occurrences = [{ offset: 3, length: 3 }];
	assert.equal(foldClipboardOffset('abcdef', occurrences, 6), 4);
	assert.equal(foldClipboardOffset('abcdef', occurrences, 3), 3);
	// 落在 chip 内部 → 吸附到 chip 右沿之后。
	assert.equal(foldClipboardOffset('abcdef', occurrences, 4), 4);
	assert.equal(foldClipboardOffset('abc', [], 3), 3);
});

test('appendOffset 把命令 chip 也算进去', () => {
	const snapshot = { draft: '/goal prove this', occurrences: [], phase: 'claimed', claim: { token: '/goal ' } };
	// token 折成 1 个字符，其余按原长度算。
	assert.equal(appendOffset(snapshot), 1 + 'prove this'.length);
	assert.equal(appendOffset({ draft: 'abc', occurrences: [], phase: 'idle' }), 3);
});

test('没有对话服务 / 会话 / 输入框时返回原因而不是抛', () => {
	assert.deepEqual(appendToComposer({ get: () => undefined }, 's', 'x'), {
		ok: false,
		reason: 'no-conversation-service'
	});
	assert.deepEqual(appendToComposer({ get: () => ({ input: { for: () => undefined } }), sessions: { scope: () => undefined } }, 's', 'x'), {
		ok: false,
		reason: 'no-session-scope'
	});
	assert.deepEqual(
		appendToComposer({ get: () => ({ input: { for: () => undefined } }), sessions: { scope: () => ({}) } }, 's', 'x'),
		{ ok: false, reason: 'no-composer-input' }
	);
});

test('没有 chip 的草稿走 setDraft', () => {
	const { ctx, get } = fakeCtx({ draft: 'hello' });
	assert.deepEqual(appendToComposer(ctx, 's', 'world'), { ok: true, mode: 'draft' });
	assert.equal(get().draft, 'hello world');
});

test('草稿里有 chip 时走 span 事件，不动已有 chip', () => {
	const { ctx, events, get } = fakeCtx({
		draft: '@a.md rest',
		occurrences: [{ offset: 0, length: 6 }]
	});
	assert.deepEqual(appendToComposer(ctx, 's', 'x'), { ok: true, mode: 'span' });
	assert.equal(events.length, 1);
	assert.equal(events[0].name, 'slash/input-insert-text');
	assert.deepEqual(events[0].payload.span, { draftRev: 3, start: 5, end: 5 });
	assert.equal(events[0].payload.text, ' x');
	assert.equal(get().draft, '@a.md rest', 'chip 草稿不能被重建');
});

test('chip 草稿没有 revision 时明确拒绝', () => {
	const { ctx } = fakeCtx({ draft: '@a.md', occurrences: [{ offset: 0, length: 5 }], noRev: true });
	assert.deepEqual(appendToComposer(ctx, 's', 'x'), { ok: false, reason: 'no-revision' });
});

test('宿主不认这次插入时返回 refused', () => {
	const { ctx } = fakeCtx({ draft: '@a.md', occurrences: [{ offset: 0, length: 5 }], refuse: true });
	assert.deepEqual(appendToComposer(ctx, 's', 'x'), { ok: false, reason: 'refused' });
});

test('底层抛错被收成结果对象', () => {
	const { ctx } = fakeCtx({ draft: '', throwOn: 'setDraft' });
	const result = appendToComposer(ctx, 's', 'x');
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'threw');
	assert.ok(result.error instanceof Error);
});

test('selectionBlock 生成 路径:行-行 + 围栏代码块', () => {
	const block = selectionBlock({ path: '001.lean', text: 'def a : Nat := 1\n', fromLine: 10, toLine: 10 });
	assert.equal(block.label, '001.lean:10');
	assert.equal(block.text, '001.lean:10\n```lean\ndef a : Nat := 1\n```');

	const multi = selectionBlock({ path: 'a/b.lean', text: 'x\ny\n\n', fromLine: 3, toLine: 9 });
	assert.equal(multi.label, 'a/b.lean:3-9');
	assert.equal(multi.text, 'a/b.lean:3-9\n```lean\nx\ny\n```');
});

test('失败原因都有可读文案', () => {
	for (const reason of ['no-conversation-service', 'no-session-scope', 'no-composer-input', 'no-revision', 'refused', 'nope']) {
		assert.equal(typeof describeComposerFailure(reason), 'string');
		assert.ok(describeComposerFailure(reason).length > 0);
	}
	assert.match(describeComposerFailure('no-composer-input'), /输入框/);
});
