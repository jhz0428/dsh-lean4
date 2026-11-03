// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 构建期依赖的定位：让三条 vendor 流水线既能在发布后的仓库里 `npm i` 后直接跑，
// 也能在开发者的旧目录布局（../../work/upstream/...）下照旧工作。
//
// 解析顺序（先命中先用）：
//   1. 本包自己的 node_modules —— 发布后的正常路径（devDependencies）；
//   2. Node 的常规解析（createRequire）—— 覆盖 workspace / hoisted 安装；
//   3. 旧开发布局：projects/fileviewer-highlight/node_modules；
//   4. 旧开发布局：work/upstream/dsh-better-sidebar/node_modules（rolldown / katex / CodeMirror）；
//   5. 旧开发布局：work/infoview-build/node_modules（@leanprover/infoview + react）。

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（本文件在 <包>/tools/deps.mjs）。 */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 构建中间产物目录。放在包内，发布后不必依赖外部 work/ 目录。 */
export const tmpDir = join(packageRoot, 'work', 'tmp');

const repoRoot = resolve(packageRoot, '..', '..');

/** 旧开发布局里的几个 node_modules，按优先级排列。 */
const LEGACY_ROOTS = [
	join(packageRoot, 'node_modules'),
	join(repoRoot, 'node_modules'),
	join(repoRoot, 'work', 'upstream', 'dsh-better-sidebar', 'node_modules'),
	join(repoRoot, 'work', 'infoview-build', 'node_modules'),
];

/**
 * 把包名（可带子路径）解析成目录。
 * @param {string} name 例：`rolldown`、`@leanprover/infoview`、`@codemirror/state`
 * @returns {string} 该包在磁盘上的目录
 */
export function resolveDependency(name) {
	const segments = name.split('/');
	for (const root of LEGACY_ROOTS) {
		const candidate = join(root, ...segments);
		if (existsSync(join(candidate, 'package.json'))) return candidate;
	}
	try {
		const require = createRequire(join(packageRoot, 'package.json'));
		return dirname(require.resolve(`${name}/package.json`));
	} catch {
		/* 落到下面的统一报错 */
	}
	throw new Error(
		`找不到构建依赖 ${name}。先安装开发依赖：\n`
			+ `  cd "${packageRoot}" && npm install\n`
			+ `（已尝试：${LEGACY_ROOTS.join('、')}，以及 Node 的常规解析）`,
	);
}

/** rolldown 的 CLI 入口（它是我们唯一的打包器，版本与宿主侧保持同源）。 */
export function resolveRolldownCli() {
	return join(resolveDependency('rolldown'), 'bin', 'cli.mjs');
}
