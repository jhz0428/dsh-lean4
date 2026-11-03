#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
//
// 语法检查：对 src/、tools/、test/ 下每个 .js/.mjs 跑一次 `node --check`。
//
// 为什么不引入 eslint：本仓库零 lint 依赖，`node --check` 已经能抓住
// 「构建脚本把 import/export 剥错了」「字符串里混进真换行」这类最常犯的错，
// 而这两类错在本项目里真发生过好几次（见 docs/lean-lsp.md 的踩坑记录）。

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const targets = ['src', 'tools', 'test'];
const SKIP_DIRS = new Set(['node_modules', 'third-party']);

/** @type {string[]} */
const files = [];

/**
 * @param {string} dir
 * @returns {void}
 */
function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (SKIP_DIRS.has(entry)) continue;
			walk(full);
			continue;
		}
		if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(full);
	}
}

for (const target of targets) walk(join(packageRoot, target));
files.sort();

const failures = [];
for (const file of files) {
	const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
	if (result.status !== 0) {
		failures.push({ file: relative(packageRoot, file), message: (result.stderr ?? '').trim() });
	}
}

if (failures.length > 0) {
	console.error(`check: ${failures.length} 个文件语法错误（共 ${files.length} 个）`);
	for (const failure of failures) {
		console.error(`  ✗ ${failure.file}`);
		console.error(
			failure.message
				.split('\n')
				.slice(0, 4)
				.map((line) => `      ${line}`)
				.join('\n'),
		);
	}
	process.exit(1);
}

// third-party 目录被跳过（它是逐字复制的上游素材，没有可检查的逻辑）。
console.log(`check: ${files.length} 个文件语法通过`);
