// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 验证「Try this」：真实 Lean 对 `exact?` 给出的建议是一条 CodeAction，
// 带可直接落地的 WorkspaceEdit。
//
//   node tools/probe-code-actions.mjs
//
// 这条链路是整个 A3（建议面板）与阶段 2 的 `lean_code_actions` 工具的地基：
// 如果 code action 的形状和上下文要求搞错了，UI 与工具都会静默返回空数组。

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChecker, startProbeServer } from './probe-support.mjs';

const SOURCE = `example (a b : Nat) (h : a = b) : a = b := by
  exact?
`;

const dir = await mkdtemp(join(tmpdir(), 'dsh-lean-actions-'));
const target = join(dir, 'ProbeActions.lean');
await writeFile(target, SOURCE, 'utf8');

const { check, report } = createChecker();
let server;
try {
	const started = await startProbeServer(target, {
		text: SOURCE,
		/* 等到「真的有诊断」为止：Lean 打开文件先推空数组，`exact?` 的建议要等精化跑完。 */
		settle: (list) => list.some((item) => item.message.includes('Try this')),
	});
	server = started.server;
	const diagnostics = started.diagnostics ?? [];
	console.log(
		`diagnostics: ${diagnostics.length} 条 → ${diagnostics
			.map((item) => `${item.severity}:${item.message.slice(0, 60)}`)
			.join(' | ')}`,
	);

	const suggestion = diagnostics.find((item) => item.message.includes('Try this'));
	check('exact? 产出「Try this」诊断', suggestion !== undefined, diagnostics.map((item) => item.message).join(' / '));
	check('该诊断带 severity', typeof suggestion?.severity === 'number');

	if (suggestion !== undefined) {
		/* 必须把**这条诊断本身**放进 context：Lean 的 provider 按诊断反查 info tree。 */
		const actions = await server.codeActions(target, suggestion.range, [suggestion]);
		console.log(`codeAction: ${actions.length} 条 → ${actions.map((item) => item.title).join(' | ')}`);
		check('能拿到 action', actions.length > 0, '空数组');
		const action = actions[0];
		check('kind 是 quickfix', action.kind === 'quickfix', action.kind);
		check('action 带扁平编辑列表', Array.isArray(action.edit?.changes), JSON.stringify(action.edit));
		const edits = action.edit?.changes ?? [];
		console.log(
			`      编辑：${edits.length} 处 → ${edits.map((item) => `${item.path}:${item.range.start.line + 1} ${JSON.stringify(item.newText)}`).join(', ')}`,
		);
		check('编辑落在本文件', edits.every((item) => item.path === target), edits.map((item) => item.path).join(','));
		check('编辑带非空 newText', edits.some((item) => typeof item.newText === 'string' && item.newText !== ''));
		check(
			'编辑内容是 exact Nat.add_right_cancel …',
			edits.some((item) => item.newText.includes('exact Nat.add_right_cancel')),
			edits.map((item) => item.newText).join(' / '),
		);
		check(
			'title 里出现 Try this',
			action.title.includes('Try this'),
			action.title,
		);
	}

	/* 语法错误处不该崩，也不该编出 action。 */
	const missing = await server.codeActions(target, { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, []);
	check('对没有诊断的区间返回空数组而不是抛错', Array.isArray(missing) && missing.length === 0);
} finally {
	server?.dispose();
	/* Windows 上 Lean 进程还没松手时 rmdir 会 EBUSY，删不掉就留着，别让探针误报失败。 */
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

report();
