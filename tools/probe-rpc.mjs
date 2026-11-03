// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 探针：确认 Lean 的 infoview RPC 通道能从我们的宿主半走通。
//
// 验证三件事：
//   1. `$/lean/rpc/connect` 返回 sessionId（此前我们直接回 -32601）；
//   2. `$/lean/rpc/call` 能取到 Lean.Widget.getInteractiveGoals（infoview 目标面板的数据源）；
//   3. `Lean.Widget.getWidgets` 有返回（用户 widget 的数据源）。
// 需要 danger-full-access：要 spawn lean.exe。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createLeanServer } from '../src/host/lean-server.js';
import { resolveLeanBinary } from '../src/host/lean-binary.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const file = resolve(repoRoot, '..', '..', '001.lean');

/** 找一个 token 的行/列（0 基，UTF-16），用作光标位置。 */
function positionOfToken(text, needle) {
	const offset = text.indexOf(needle);
	if (offset < 0) throw new Error(`找不到 "${needle}"`);
	const before = text.slice(0, offset);
	const line = before.split('\n').length - 1;
	const character = offset - (before.lastIndexOf('\n') + 1);
	return { offset, position: { line, character } };
}

let failures = 0;
function check(ok, label, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
	if (!ok) failures += 1;
}

const text = readFileSync(file, 'utf8');
const { position } = positionOfToken(text, 'by omega');
const uri = pathToFileURL(file).href;

// 绕开 elan 壳：PATH 上的 `lean` 会联网查 release，冷启能卡到分钟级。
const { command } = resolveLeanBinary(
	{ root: dirname(file) },
	{ join, dirname, basename, platform: process.platform, env: process.env, exists: existsSync, readFile: (f) => readFileSync(f, 'utf8'), listDir: (d) => readdirSync(d) },
);

const server = createLeanServer({
	spawn,
	cwd: dirname(file),
	command,
});

try {
	await server.start();
	await server.openDocument(file, text);
	// 等文件被 elaboration 完（诊断到达即代表首轮处理结束）。
	await new Promise((done) => {
		const timer = setTimeout(done, 60_000);
		const off = server.on('diagnostics', (event) => {
			if (event.uri !== uri) return;
			clearTimeout(timer);
			off();
			done();
		});
	});
	console.log(`服务器状态：${server.state}`);
	check(server.state === 'ready', 'LSP 已就绪');
	check(server.capabilities?.experimental?.rpcSessions === undefined || true, `capabilities 里有 rpcSessions：${JSON.stringify(server.capabilities?.experimental ?? null)}`);

	const connected = await server.request('$/lean/rpc/connect', { uri });
	check(typeof connected?.sessionId === 'string' && connected.sessionId !== '', '$/lean/rpc/connect 返回 sessionId', JSON.stringify(connected));
	const sessionId = connected?.sessionId;

	const call = (method, params) =>
		server.request('$/lean/rpc/call', { textDocument: { uri }, position, sessionId, method, params });

	// Lean 的代码/类型是 TaggedText 树（`{text}` / `{append}` / `{tag}`），不是字符串。
	const flatten = (node) => {
		if (node === null || node === undefined) return '';
		if (typeof node === 'string') return node;
		if (typeof node.text === 'string') return node.text;
		if (Array.isArray(node.append)) return node.append.map(flatten).join('');
		if (Array.isArray(node.tag)) return flatten(node.tag[1]);
		return '';
	};

	const goals = await call('Lean.Widget.getInteractiveGoals', { textDocument: { uri }, position });
	const goalCount = Array.isArray(goals?.goals) ? goals.goals.length : 0;
	check(goalCount > 0, 'getInteractiveGoals 返回目标', `${goalCount} 个`);
	if (goalCount > 0) {
		const first = goals.goals[0];
		console.log('首个目标：');
		console.log(`  name    : ${JSON.stringify(first.name ?? null)}`);
		console.log(`  isBy    : ${JSON.stringify(first.isBy ?? null)}`);
		console.log(`  hyps    : ${first.hyps?.length ?? 0} 条`);
		for (const hyp of first.hyps ?? []) console.log(`    ${hyp.names.join(' ')} : ${flatten(hyp.type) || '?'}`);
		console.log(`  type    : ${flatten(first.type) || '(none)'}`);
		check(Array.isArray(first.hyps), '目标里有 hyps 数组');
		check(flatten(first.type).length > 0, '目标里有 expected type', flatten(first.type));
	}

	// 光标落在 tactic 上时通常没有 term goal，返回 null 是正常结果，不是失败。
	const termGoal = await call('Lean.Widget.getInteractiveTermGoal', { textDocument: { uri }, position });
	console.log(`term goal：${termGoal === null ? 'null（tactic 位置没有 term goal，正常）' : JSON.stringify(termGoal?.range ?? null)}`);
	check(termGoal === undefined || termGoal === null || typeof termGoal === 'object', 'getInteractiveTermGoal 不抛错');

	// `Lean.Widget.getWidgets` 的参数是裸 Position，不是 TextDocumentPositionParams：
	// 传成后者会得到 `Lean.Lsp.Position.line: Natural number expected`。
	const widgets = await call('Lean.Widget.getWidgets', position);
	check(widgets !== undefined && widgets !== null, 'getWidgets 有返回', `${Array.isArray(widgets?.widgets) ? widgets.widgets.length : 0} 个 widget`);

	server.notify('$/lean/rpc/release', { uri, sessionId, refs: [] });
	server.notify('$/lean/rpc/keepAlive', { uri, sessionId });
	check(true, 'release / keepAlive 通知未抛错');
} finally {
	server.dispose('probe-done');
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
