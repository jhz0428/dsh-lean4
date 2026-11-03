// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 真机探针的公共脚手架：拉起一个真实的 `lean --server` 并等它把文件精化完。
//
// 三个探针（probe-folding / probe-code-actions / probe-agent-tools）都要做同一件
// 开头：解析 toolchain 里的真二进制（**不要走 PATH 上的 elan 壳**，那会联网查
// release、冷启动能卡满 180 秒，见 docs/lean-lsp.md）、spawn、initialize、didOpen、
// 等 publishDiagnostics。抽出来只写一次。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as nodePath from 'node:path';
import { createLeanServer } from '../src/host/lean-server.js';
import { resolveLeanBinary } from '../src/host/lean-binary.js';

/** 解析要用的 lean 二进制（`LEAN_BIN` 可覆盖，调试用）。 */
export function leanCommandFor(target) {
	if (process.env.LEAN_BIN !== undefined) return { command: process.env.LEAN_BIN, source: 'env LEAN_BIN' };
	return resolveLeanBinary(
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
		},
	);
}

/** 计数式断言器：跑完 `report()` 统一退出码。 */
export function createChecker() {
	const failures = [];
	const check = (label, condition, detail) => {
		if (condition) {
			console.log(`PASS  ${label}`);
		} else {
			failures.push(label);
			console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
		}
	};
	const report = (logLines = []) => {
		if (failures.length === 0) {
			console.log('\nall probes passed');
			return;
		}
		console.log(`\n${failures.length} check(s) failed`);
		if (logLines.length > 0) console.log(`last log lines:\n${logLines.slice(-10).join('\n')}`);
		process.exit(1);
	};
	return { check, report, failures };
}

/**
 * 拉起服务器、打开文件、等到诊断发布。
 *
 * @param {string} target 绝对路径
 * @param {{timeoutMs?: number, text?: string, settle?: (list: any[]) => boolean}} [options]
 *   `settle` 决定「诊断算不算等到了」。Lean 打开文件时会先推一条**空的**
 *   publishDiagnostics（还没开始精化），只看「收到过」会拿到 `[]` 就往下走。
 *   默认等到非空；超时不抛错，把当前快照交回去让调用方自己判断。
 * @returns {Promise<{server: object, uri: string, text: string, lines: string[], diagnostics: any[], logLines: string[]}>}
 */
export async function startProbeServer(target, options = {}) {
	const timeoutMs = options.timeoutMs ?? 180_000;
	const settle = options.settle ?? ((list) => Array.isArray(list) && list.length > 0);
	const text = options.text ?? (await readFile(target, 'utf8'));
	const resolved = leanCommandFor(target);
	console.log(`lean binary: ${resolved.command}（${resolved.source}）`);

	const logLines = [];
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

	const byUri = new Map();
	server.on('diagnostics', ({ uri, diagnostics }) => byUri.set(uri, diagnostics));

	const started = Date.now();
	await server.start();
	console.log(`initialize in ${Date.now() - started}ms`);

	const opened = await server.openDocument(target, text);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !settle(byUri.get(opened.uri) ?? [])) {
		await new Promise((done) => setTimeout(done, 100));
	}
	if (!byUri.has(opened.uri)) throw new Error(`publishDiagnostics never arrived for ${target}`);

	return {
		server,
		uri: opened.uri,
		text,
		lines: text.split('\n'),
		diagnostics: byUri.get(opened.uri) ?? [],
		logLines,
	};
}

/** 找到第一处包含 `needle` 的行，返回 0-based 行号与命中列的 0-based 偏移。 */
export function findToken(lines, needle) {
	const line = lines.findIndex((item) => item.includes(needle));
	if (line < 0) throw new Error(`cannot find a line containing "${needle}"`);
	return { line, character: lines[line].indexOf(needle) };
}
