// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 合成 packages/dsh-lean4/lib/index.js —— 宿主半的可加载模块。
//
// 宿主半由 DSH 的 loader 用标准 Node ESM 直接 `import()`。本包用 `link:` 安装，
// 所以**只能** import `node:` 内建模块：任何裸包名都要解析到本插件自己的
// node_modules，那正是 2026-10-26 启动失败的成因。这个脚本因此在构建期就拒绝
// 非 `node:` 的 import。
//
// 变换与 build-client.mjs 同构：去掉相对 import 行、去掉顶层 `export ` 前缀、
// 按依赖顺序拼接、检查顶层重名，最后统一导出 name/inject/apply。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const outFile = path.join(packageDir, 'lib', 'index.js');

/** 内联顺序即依赖顺序。 */
const SOURCES = [
	'src/host/hostlog.js',
	'src/host/lean-binary.js',
	'src/host/lsp-framing.js',
	'src/host/lean-server.js',
	'src/host/tools.js',
	'src/host/plugin.js',
];

const builtinImports = new Map();

function stripModuleSyntax(source, label) {
	const declared = [];
	const kept = [];
	for (const line of source.split('\n')) {
		const imported = /^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/.exec(line);
		if (imported !== null) {
			const specifier = imported[2];
			if (specifier.startsWith('./') || specifier.startsWith('../')) {
				/* 同级源码按 SOURCES 的顺序内联进同一作用域，import 行本身丢弃。 */
				continue;
			}
			if (!specifier.startsWith('node:')) {
				throw new Error(`${label}: refusing a non-builtin import "${specifier}" (a link: plugin must not resolve packages)`);
			}
			const clause = imported[1];
			/* 同一个模块可能被多个源文件分别 import（`node:fs` 就是这样）；
			   按 specifier 合并成一条，避免出现 `import {a}, {b} from` 这种非法语法。 */
			if (builtinImports.has(specifier)) {
				builtinImports.set(specifier, [...builtinImports.get(specifier), clause]);
			} else {
				builtinImports.set(specifier, [clause]);
			}
			continue;
		}
		if (/^import\s*['"]/.test(line)) {
			throw new Error(`${label}: side-effect-only imports are not supported`);
		}
		const declaration = /^(?:export\s+)?(?:async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
		if (declaration !== null) declared.push({ name: declaration[2], label, line: line.trim().slice(0, 80) });
		kept.push(line.startsWith('export ') ? line.slice('export '.length) : line);
	}
	const text = kept.join('\n');
	const leftover = text.split('\n').findIndex((line) => /^\s*(import|export)\b/.test(line));
	if (leftover >= 0) {
		throw new Error(`${label}: module syntax survived the transform at line ${leftover + 1}`);
	}
	return { text, declared };
}

const pieces = [];
const declarations = new Map();
for (const relative of SOURCES) {
	const source = await readFile(path.join(packageDir, relative), 'utf8');
	const { text, declared } = stripModuleSyntax(source, relative);
	for (const entry of declared) {
		if (declarations.has(entry.name)) {
			const first = declarations.get(entry.name);
			throw new Error(
				`duplicate top-level declaration "${entry.name}": ${first.label} (${first.line}) and ${entry.label} (${entry.line})`,
			);
		}
		declarations.set(entry.name, entry);
	}
	pieces.push(`//#region inlined ${relative}\n${text.trimEnd()}\n//#endregion`);
}

for (const required of ['name', 'inject', 'apply']) {
	if (!declarations.has(required)) throw new Error(`the host sources no longer declare "${required}"`);
}

const importLines = [];
for (const [specifier, clauses] of builtinImports.entries()) {
	const named = [];
	const others = [];
	for (const clause of clauses) {
		const braces = /^\{\s*([\s\S]*?)\s*\}$/.exec(clause);
		if (braces !== null) {
			for (const part of braces[1].split(',')) {
				const name = part.trim();
				if (name !== '' && !named.includes(name)) named.push(name);
			}
		} else {
			others.push(clause);
		}
	}
	for (const clause of others) importLines.push(`import ${clause} from '${specifier}';`);
	if (named.length > 0) importLines.push(`import { ${named.join(', ')} } from '${specifier}';`);
}
const importBlock = importLines.join('\n');

const bundle = `// 由 tools/build-host.mjs 生成，请勿手改。
// 本文件是构建产物：内容全部是本项目自有源码，按 MPL-2.0 授权（见 LICENSE）。
// 源码：${SOURCES.join('、')}
// 重新生成：node tools/build-host.mjs

${importBlock}

${pieces.join('\n\n')}

export { name, inject, apply };
`;

await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, bundle);
console.log(`wrote ${path.relative(packageDir, outFile)} (${bundle.length} bytes, ${declarations.size} top-level declarations)`);
