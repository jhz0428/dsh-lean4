// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 构建：把 KaTeX 的 UMD 包成「惰性 vendor」，供 markdown-lite 渲染数学公式。
//
// 为什么只需要 JS，不需要 CSS/字体：
//   DSH 的 Web 前端在 index.html 里已经全局加载了 vendor-*.css，那份 CSS 里带
//   25 条 .katex-* 规则与 20 个 @font-face（字体文件在 dist/assets/fonts/）。
//   我们的编辑器永远运行在这个页面里，所以直接复用宿主的样式与字体，
//   不重复塞 23 KB CSS + 26 万字节 woff2。
//
// 为什么包进函数：
//   katex.min.js 是 UMD，会摸 module/exports/self。直接内联会在插件求值时
//   污染或读取全局，而且它求值即执行（24 万字符的解析）。包进 IIFE 后只在首次
//   需要渲染公式时求值一次，结果挂在 globalThis.__DCH_KATEX__。
//
// 产物：work/tmp/katex.js（由 tools/build-client.mjs 以 lazy vendor 方式内联）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveDependency, tmpDir } from './deps.mjs';

const KATEX_DIR = resolveDependency('katex');
const SOURCE = join(KATEX_DIR, 'dist', 'katex.min.js');
const OUTPUT = join(tmpDir, 'katex.js');

if (!existsSync(SOURCE)) {
	throw new Error(`找不到 KaTeX 产物：${SOURCE}`);
}

const version = JSON.parse(readFileSync(join(KATEX_DIR, 'package.json'), 'utf8')).version;
const source = readFileSync(SOURCE, 'utf8').trimEnd();

/*
 * UMD 的第一个分支是 `"object"==typeof exports&&"object"==typeof module`
 * → `module.exports = factory()`。所以我们只要在函数作用域里放两个本地
 * `module`/`exports`，它就会乖乖写进我们的盒子，不碰 globalThis。
 */
const output = `// 由 tools/build-katex.mjs 生成，请勿手改。
// KaTeX ${version}（dist/katex.min.js，${source.length} 字符）。
// 样式与字体由宿主 Web 前端提供（vendor CSS 里已有 .katex-* 与 @font-face）。
globalThis.__DCH_KATEX__ = (function () {
  var module = { exports: {} };
  var exports = module.exports;
${source}
  var exported = module.exports;
  if (exported !== null && typeof exported === 'object' && typeof exported.renderToString === 'function') return exported;
  /* UMD 若走了 global 分支，回落到它挂上去的全局名。 */
  return typeof globalThis.katex === 'object' && globalThis.katex !== null ? globalThis.katex : null;
})();
`;

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, output, 'utf8');
console.log(`work/tmp/katex.js: ${Buffer.byteLength(output, 'utf8')} 字节（KaTeX ${version}）`);
