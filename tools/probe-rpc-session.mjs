// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 探针：RPC 会话到底是什么时候失效的（决定「Outdated RPC session」的根因）。
//
// 三个假设，逐个测：
//   A. 时间失效 —— 30 s 不发 keepAlive 就过期（Lean FileWorker/RpcSession.keepAliveTimeMs = 30000）；
//   B. keepAlive 有效 —— 每 10 s 发一次，35 s 后照样能 call；
//   C. 改头部（imports）会让 worker 重启，会话随之失效。
//
// 需要能 spawn lean.exe（danger-full-access）。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createLeanServer } from '../src/host/lean-server.js';
import { resolveLeanBinary } from '../src/host/lean-binary.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const file = resolve(repoRoot, '..', '..', '001.lean');
const text = readFileSync(file, 'utf8');
const uri = pathToFileURL(file).href;

const { command } = resolveLeanBinary(
	{ root: dirname(file) },
	{
		join,
		dirname,
		basename,
		platform: process.platform,
		env: process.env,
		exists: existsSync,
		readFile: (f) => readFileSync(f, 'utf8'),
		listDir: (d) => readdirSync(d),
	},
);

let failures = 0;
function check(ok, label, detail) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
	if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 在 `by omega` 处调一次 getInteractiveGoals，返回 `{ok, code, message}`。 */
async function callGoals(server, sessionId) {
	const offset = text.indexOf('by omega');
	const before = text.slice(0, offset);
	const position = { line: before.split('\n').length - 1, character: offset - (before.lastIndexOf('\n') + 1) };
	try {
		await server.request('$/lean/rpc/call', {
			sessionId,
			method: 'Lean.Widget.getInteractiveGoals',
			position,
			textDocument: { uri },
			params: { textDocument: { uri }, position },
		});
		return { ok: true, code: null, message: '' };
	} catch (error) {
		return { ok: false, code: error?.code ?? null, message: error?.message ?? String(error) };
	}
}

async function connect(server) {
	const connected = await server.request('$/lean/rpc/connect', { uri });
	const sessionId = connected?.sessionId;
	if (typeof sessionId !== 'string' || sessionId === '') throw new Error('rpc/connect 没给 sessionId');
	return sessionId;
}

const server = createLeanServer({ spawn, cwd: dirname(file), command });
try {
	await server.start();
	await server.openDocument(file, text);
	await sleep(4000); // 等首轮 elaboration

	const first = await connect(server);
	const baseline = await callGoals(server, first);
	check(baseline.ok, '刚连上就能 call', baseline.ok ? '' : `${baseline.code} ${baseline.message}`);

	/* A：不发 keepAlive，等 35 s。 */
	console.log('\n[A] 35 s 不发 keepAlive …');
	await sleep(35_000);
	const afterIdle = await callGoals(server, first);
	check(!afterIdle.ok && afterIdle.code === -32900, '会话按 30 s 超时失效（符合 Lean keepAliveTimeMs）', `${afterIdle.code} ${afterIdle.message}`);

	/* B：重连后每 10 s 发 keepAlive，同样等 35 s。 */
	console.log('\n[B] 重连并每 10 s 发 keepAlive，等 35 s …');
	const second = await connect(server);
	const timer = setInterval(() => {
		try {
			server.notify('$/lean/rpc/keepAlive', { uri, sessionId: second });
		} catch {
			/* ignore */
		}
	}, 10_000);
	await sleep(35_000);
	const afterKeepAlive = await callGoals(server, second);
	clearInterval(timer);
	check(afterKeepAlive.ok, 'keepAlive 保住了会话', afterKeepAlive.ok ? '' : `${afterKeepAlive.code} ${afterKeepAlive.message}`);

	/* C：改头部（加一行 import）再 call，看 worker 是否重启、会话是否失效。 */
	console.log('\n[C] 改文件头部（加一行 import），再 call …');
	const third = await connect(server);
	const withImport = `import Std.Data.List.Basic\n${text}`;
	await server.changeDocument(file, withImport);
	await sleep(6000);
	const afterHeader = await callGoals(server, third);
	check(true, '改头部后再 call 的结果（用于判断触发条件）', afterHeader.ok ? 'ok（会话存活）' : `${afterHeader.code} ${afterHeader.message}`);
} finally {
	server.dispose('probe-done');
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
