// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 打 infoview 那块 vendor：npm 预构建 dist + React 18 → 一个 IIFE；CSS（含 codicon 字体）转成字符串常量。
//
// 产物：
//   work/tmp/infoview.js     —— 定义 globalThis.__DCH_INFOVIEW__ = { renderInfoview }
//   work/tmp/infoview-css.js —— 定义 INFOVIEW_CSS（style 文本，字体已内联为 data URI）
//
// 为什么入口要临时写进 node_modules：
//   rolldown 按「入口文件所在目录」向上找 node_modules。本包的 tools/ 目录在
//   `npm i` 之后确实能找到依赖，但在旧的开发布局里 @leanprover/infoview 住在
//   work/infoview-build/node_modules，从 tools/ 走上去是找不到的。
//   把入口放到「装着 @leanprover/infoview 的那个 node_modules」里，两种布局都能解析，
//   也不需要把仓库钉死在某一个目录形状上。跑完就删。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { packageRoot, resolveDependency, resolveRolldownCli, tmpDir } from './deps.mjs';

/** 入口源码（本包 tools/ 下，带 SPDX 头，便于人读）。 */
const entrySource = resolve(packageRoot, 'tools', 'infoview-entry.js');
const infoviewDir = resolveDependency('@leanprover/infoview');
const dist = join(infoviewDir, 'dist');
const rolldown = resolveRolldownCli();

if (!existsSync(entrySource)) throw new Error(`缺少入口：${entrySource}`);
if (!existsSync(join(dist, 'index.production.min.js'))) {
	throw new Error(`@leanprover/infoview 的 dist 不完整：${dist}`);
}

mkdirSync(tmpDir, { recursive: true });

// `.../node_modules/@leanprover/infoview` → `.../node_modules`
const modulesRoot = dirname(dirname(infoviewDir));
const temporaryEntry = join(modulesRoot, '.dsh-lean4-infoview-entry.mjs');
writeFileSync(temporaryEntry, readFileSync(entrySource, 'utf8'), 'utf8');

const bundle = resolve(tmpDir, 'infoview.js');
try {
	execFileSync(
		process.execPath,
		[rolldown, temporaryEntry, '--format', 'iife', '--name', 'DCH_INFOVIEW', '--file', bundle, '--platform', 'browser', '--minify'],
		{ cwd: packageRoot, stdio: 'inherit' },
	);
} finally {
	rmSync(temporaryEntry, { force: true });
}

// 失败模式守卫：依赖没解析上时 rolldown 会安静地打出一个只剩全局赋值的空 bundle。
const bundleSize = statSync(bundle).size;
if (bundleSize < 200_000) {
	throw new Error(
		`infoview bundle 只有 ${bundleSize} 字节，说明 @leanprover/infoview / react 没被真正打进来。\n`
			+ `检查 ${modulesRoot} 里是否同时装着 @leanprover/infoview 与 react@18。`,
	);
}

/** CSS 里的 codicon 字体在 dist 目录内，转成 data URI 才能只发一个文件。 */
function inlineFonts(css) {
	const font = readFileSync(resolve(dist, 'codicon.ttf')).toString('base64');
	return css.replace(/url\(([^)]*codicon\.ttf[^)]*)\)/g, `url(data:font/ttf;base64,${font})`);
}

const css = inlineFonts(readFileSync(resolve(dist, 'index.css'), 'utf8'));
const cssJs = resolve(tmpDir, 'infoview-css.js');
writeFileSync(cssJs, `var INFOVIEW_CSS = ${JSON.stringify(css)};\n`, 'utf8');

// 顺手留一份给预览页用。
copyFileSync(resolve(dist, 'index.css'), resolve(tmpDir, 'infoview.css'));

const kb = (path) => `${(statSync(path).size / 1024).toFixed(0)} KB`;
console.log(`infoview.js: ${kb(bundle)}`);
console.log(`infoview-css.js: ${kb(cssJs)}（含内联字体）`);
