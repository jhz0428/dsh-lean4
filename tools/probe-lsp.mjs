// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 用真实 `lean --server` 验证宿主侧 LSP 客户端（不经过 DSH、不重启应用）。
//
//   node tools/probe-lsp.mjs [file.lean]
//
// 断言的是「浏览器半将要依赖的那几件事」：initialize 握手、didOpen 之后的
// publishDiagnostics、plainGoal 在 tactic 块里给出目标、hover 能返回 Markdown。

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createLeanServer } from '../src/host/lean-server.js';
import { resolveLeanBinary } from '../src/host/lean-binary.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';

/* 默认目标固定在仓库根：不依赖当前工作目录，从本文件位置往上四跳。 */
const target = process.argv[2] === undefined
	? resolve(import.meta.dirname, '..', '..', '..', '..', '..', '001.lean')
	: resolve(process.argv[2]);
const text = await readFile(target, 'utf8');
const lines = text.split('\n');

const failures = [];
const check = (label, condition, detail) => {
	if (condition) {
		console.log(`PASS  ${label}`);
	} else {
		failures.push(label);
		console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
	}
};

const diagnostics = new Map();
const logLines = [];
/*
 * 别再用 PATH 上的 `lean`：那是 elan 的分发壳，会先联网查 release，
 * 冷启能卡满 180 秒（`docs/lean-lsp.md` 里那条「启动慢 40 倍」）。
 */
const resolved = process.env.LEAN_BIN === undefined
	? resolveLeanBinary(
			{ root: dirname(target) },
			{
				join: nodePath.join,
				dirname: nodePath.dirname,
				basename: nodePath.basename,
				platform: process.platform,
				env: process.env,
				exists: existsSync,
				readFile: (file) => readFileSync(file, 'utf8'),
				listDir: (dir) => readdirSync(dir),
			}
		)
	: { command: process.env.LEAN_BIN, source: 'env LEAN_BIN' };
console.log(`lean binary: ${resolved.command}（${resolved.source}）`);

const server = createLeanServer({
	spawn,
	cwd: dirname(target),
	command: resolved.command,
	args: ['--server'],
	log: (line) => {
		logLines.push(line);
		if (process.env.PROBE_VERBOSE === '1') console.log(`  [log] ${line}`);
	},
});
server.on('diagnostics', ({ uri, diagnostics: list }) => diagnostics.set(uri, list));

const started = Date.now();
const capabilities = await server.start();
console.log(`initialize in ${Date.now() - started}ms; positionEncoding=${capabilities?.positionEncoding ?? 'unset'}`);
check('initialize returns capabilities', capabilities !== null && typeof capabilities === 'object');
check(
	'server advertises textDocumentSync',
	capabilities?.textDocumentSync !== undefined,
	JSON.stringify(capabilities?.textDocumentSync),
);

const opened = await server.openDocument(target, text);
check('didOpen accepted', typeof opened.version === 'number', `version=${opened.version}`);

/** Wait until publishDiagnostics lands for this file (Lean pushes it after elaborating). */
async function waitForDiagnostics(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (diagnostics.has(opened.uri)) return diagnostics.get(opened.uri);
		await new Promise((done) => setTimeout(done, 100));
	}
	return undefined;
}

const list = await waitForDiagnostics(120_000);
check('publishDiagnostics arrives', list !== undefined, 'timed out');
if (list !== undefined) {
	console.log(`      ${list.length} diagnostic(s): ${list.map((item) => `${item.severity}:${item.message.slice(0, 60)}`).join(' | ') || '(none)'}`);
	check('001.lean elaborates without errors', list.every((item) => (item.severity ?? 1) !== 1), 'saw an error severity');
}

/**
 * `goalsAccomplished` 是 silent 消息，只有在 initialize 里声明
 * `capabilities.lean.silentDiagnosticSupport` 之后才会下发；而且它比 `#eval` 输出晚一帧。
 */
async function waitForTagged(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	const hasTag = (list) => list.some((item) => Array.isArray(item.leanTags) && item.leanTags.includes(2));
	while (Date.now() < deadline) {
		if (hasTag(diagnostics.get(opened.uri) ?? [])) break;
		await new Promise((done) => setTimeout(done, 100));
	}
	return diagnostics.get(opened.uri) ?? [];
}

const tagged = await waitForTagged(60_000);
const accomplished = tagged.filter((item) => Array.isArray(item.leanTags) && item.leanTags.includes(2));
console.log(`      goalsAccomplished 行: ${accomplished.map((item) => item.range.start.line + 1).join(',') || '(none)'}`);
check('silentDiagnosticSupport 生效：拿到 leanTags:[2]', accomplished.length > 0, '没有 goalsAccomplished 诊断');
check('goalsAccomplished 都标了 isSilent', accomplished.every((item) => item.isSilent === true));

/** First line containing `needle` (and the column just past it). */
function findToken(needle) {
	const index = lines.findIndex((line) => line.includes(needle));
	if (index < 0) throw new Error(`cannot find a line containing "${needle}"`);
	return { line: index, column: lines[index].indexOf(needle) + 1 };
}

const tacticToken = findToken('by omega');
const goal = await server.plainGoal(target, { line: tacticToken.line, character: tacticToken.column + 2 });
console.log(`      goal at line ${tacticToken.line + 1}: ${JSON.stringify(goal)?.slice(0, 240)}`);
check('plainGoal returns a goal inside a tactic block', goal !== null && goal.goals.length > 0);

const natLine = findToken('def double (n : Nat)').line;
const natColumn = lines[natLine].indexOf('Nat');
const hover = await server.hover(target, { line: natLine, character: natColumn + 1 });
console.log(`      hover on Nat: ${JSON.stringify(hover?.text ?? null)?.slice(0, 200)}`);
check('hover on Nat returns text', hover !== null && hover.text.length > 0);

/* 补全要在标识符内部触发：Lean 按光标前的词形回候选。 */
const completion = await server.completion(target, { line: natLine, character: lines[natLine].indexOf('double') + 3 });
console.log(`      completion items: ${completion.items.length}, first: ${completion.items.slice(0, 5).map((item) => item.label).join(',')}`);
check('completion returns items', completion.items.length > 0);

const definitions = await server.definition(target, { line: natLine, character: natColumn + 1 });
check('definition returns at most a location list', Array.isArray(definitions));

server.dispose();
if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	if (logLines.length > 0) console.log(`last log lines:\n${logLines.slice(-10).join('\n')}`);
	process.exit(1);
}
console.log('\nall probes passed');
