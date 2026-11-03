// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * 把选中的代码塞进 DSH 对话输入框（「添加到对话」）。
 *
 * 走宿主自己的会话输入通道，而不是往 DOM 里塞文本：
 * `ctx.get('conversation')` 是应用内部插件同样使用的**免 inject** 读法，
 * `input.setDraft` 会把整份草稿重建成字符串（会压平已有的 chip），
 * 所以草稿里已经有 chip 时改用 span 事件 `slash/input-insert-text` 插入。
 *
 * 这条路径与 better-sidebar 自己的选择浮层完全一致（见上游
 * `src/client/conversation-draft.ts`），因此 chip / 命令 / 提交阶段的门禁
 * 全部由宿主负责，我们只负责算「追加到末尾」的偏移。
 */

/** 在草稿末尾接一段文本，保证中间有一个空格分隔。 */
export function appendText(draft, text) {
	if (draft === '') return text;
	if (/\s$/.test(draft) || /^\s/.test(text)) return draft + text;
	return `${draft} ${text}`;
}

/** 插入前需要的分隔符（草稿非空且不以空白结尾时是一个空格）。 */
export function leadFor(draft) {
	return draft === '' || /\s$/.test(draft) ? '' : ' ';
}

/**
 * 把草稿里的绝对下标折成宿主的 detect 投影下标：每个 chip 只占 1 个字符。
 */
export function foldClipboardOffset(draft, occurrences, target) {
	let shrink = 0;
	for (const occurrence of occurrences) {
		const end = occurrence.offset + occurrence.length;
		if (target >= end) {
			shrink += occurrence.length - 1;
			continue;
		}
		if (target > occurrence.offset) return occurrence.offset - shrink + 1;
		break;
	}
	return target - shrink;
}

/** 追加到草稿末尾的 detect 投影偏移；拿不到时返回 undefined。 */
export function appendOffset(snapshot) {
	const draft = snapshot.draft ?? '';
	const occurrences = snapshot.occurrences ?? [];
	const claim = snapshot.claim;
	const token = snapshot.phase === 'claimed' && claim !== undefined && draft.startsWith(claim.token)
		? claim.token
		: '';
	if (token === '') return foldClipboardOffset(draft, occurrences, draft.length);
	const rest = draft.slice(token.length);
	const inner = occurrences
		.filter((occurrence) => occurrence.offset >= token.length)
		.map((occurrence) => ({ offset: occurrence.offset - token.length, length: occurrence.length }));
	return 1 + foldClipboardOffset(rest, inner, rest.length);
}

/**
 * 把一段文本追加到当前会话的对话草稿。
 *
 * @returns `{ ok: true, mode: 'draft' | 'span' }` 或 `{ ok: false, reason }`。
 */
export function appendToComposer(ctx, sessionId, text) {
	try {
		const conversation = ctx?.get?.('conversation');
		if (conversation === undefined || conversation === null) {
			return { ok: false, reason: 'no-conversation-service' };
		}
		const scope = ctx?.sessions?.scope?.(sessionId);
		if (scope === undefined) return { ok: false, reason: 'no-session-scope' };
		const input = conversation.input?.for?.(scope);
		if (input === undefined || input === null) return { ok: false, reason: 'no-composer-input' };
		const snapshot = input.state.getSnapshot();
		const draft = snapshot.draft ?? '';
		const occurrences = snapshot.occurrences ?? [];
		const hasChips = occurrences.length > 0 || snapshot.phase === 'claimed';
		if (!hasChips) {
			input.setDraft(appendText(draft, text));
			return { ok: true, mode: 'draft' };
		}
		const at = appendOffset(snapshot);
		if (snapshot.draftRev === undefined || at === undefined) {
			return { ok: false, reason: 'no-revision' };
		}
		scope.emit('slash/input-insert-text', {
			text: `${leadFor(draft)}${text}`,
			span: { draftRev: snapshot.draftRev, start: at, end: at }
		});
		const after = input.state.getSnapshot();
		if (after.draftRev === snapshot.draftRev) return { ok: false, reason: 'refused' };
		return { ok: true, mode: 'span' };
	} catch (error) {
		return { ok: false, reason: 'threw', error };
	}
}

/**
 * 选中内容 → 一段可以塞进对话的文本：首行是 `路径:起-止`，随后是围栏代码块。
 *
 * @param options.path - 工作区相对路径（能拿到相对路径就传相对的）。
 * @param options.text - 选中的原文。
 * @param options.fromLine - 起始行（1 基）。
 * @param options.toLine - 结束行（1 基）。
 * @param options.language - 围栏的语言标记，默认 `lean`。
 */
export function selectionBlock(options) {
	const fromLine = options.fromLine ?? 1;
	const toLine = options.toLine ?? fromLine;
	const where = fromLine === toLine ? `${options.path}:${fromLine}` : `${options.path}:${fromLine}-${toLine}`;
	const body = String(options.text ?? '').replace(/\s+$/, '');
	const fence = '```';
	return { label: where, text: `${where}\n${fence}${options.language ?? 'lean'}\n${body}\n${fence}` };
}

/** 失败原因 → 给用户看的一句话。 */
export function describeComposerFailure(reason) {
	switch (reason) {
		case 'no-conversation-service':
			return '当前界面没有对话服务（请打开一个会话）';
		case 'no-session-scope':
			return '拿不到当前会话';
		case 'no-composer-input':
			return '找不到对话输入框';
		case 'no-revision':
			return '对话草稿不可写（正在提交？）';
		case 'refused':
			return '宿主拒绝了这次插入';
		default:
			return '插入对话失败';
	}
}
