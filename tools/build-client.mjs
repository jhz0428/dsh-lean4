// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 构建：把 CodeMirror 子集 + 自有源码内联成一份浏览器可直接 eval 的模块。
//
// 为什么要内联而不是让浏览器按 ESM import：
//   1) DSH 的客户端插件只加载一个 `lib/client.js`，没有 import map；
//   2) CodeMirror 是构建期由 rolldown 打成 IIFE 的（`work/tmp/cm.js`），它挂在
//      模块作用域的 `DCM` 上，自有源码按 `DCM` 引用它。
//
// 做法：剥掉每份源文件的 `import …` 行与 `export ` 前缀，按声明顺序拼接，最后追加
// `window.__ModuleLoader__.load(...)`。拼接前检查顶层声明重名——重名会让后一个
// 静默覆盖前一个，是这类「字符串拼接式打包」最容易埋的坑。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from './deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/** 顺序有约束：被依赖的在前（`LEAN_SPEC` 先于 `mountEditor`）。 */
const SOURCES = [
	'src/lean-mode.js',
	'src/save.js',
	'src/conversation.js',
	'src/style.js',
	'src/lean-comments.js',
	'src/markdown-lite.js',
	'src/doc-markdown.js',
	// Apache-2.0 素材（对勾图标）单独成文件，必须排在用到它的 gutter-marks 之前。
	'src/third-party/goals-accomplished-icon.js',
	'src/gutter-marks.js',
	'src/folding.js',
	'src/code-actions.js',
	'src/navigation.js',
	'src/paths.js',
	'src/editor.js',
	'src/lean-lsp.js',
	'src/lsp-extensions.js',
	'src/infoview-config.js',
	'src/infoview.js',
	'src/client-body.js'
];

/**
 * 前置 vendor（按顺序拼接）：
 *   - `cm.js`：CodeMirror 子集，由 tools/build-codemirror.mjs 生成，挂 `DCM`；
 *   - `katex.js`：KaTeX 的 UMD，由 tools/build-katex.mjs 生成，挂 `__DCH_KATEX__`；
 *   - `infoview.js`：官方 infoview 的 IIFE，挂 `globalThis.__DCH_INFOVIEW__`；
 *   - `infoview-css.js`：那份 bundle 需要的样式，挂 `INFOVIEW_CSS`。
 * 各自有构建脚本，这里只做存在性校验与拼接。
 */
const VENDORS = [
	{ label: 'CodeMirror', file: join(tmpDir, 'cm.js'), hint: 'node tools/build-codemirror.mjs' },
	{
		label: 'KaTeX',
		file: join(tmpDir, 'katex.js'),
		hint: 'node tools/build-katex.mjs',
		// 27 万字符的 UMD，求值即解析；注释里没有公式时不该付这笔钱。
		// `accessor` 是它暴露给 src/ 的入口名（markdown-lite 通过它惰性取用）。
		lazy: 'ensureKatex',
		lazyGlobal: '__DCH_KATEX__',
		accessor: '__DCH_ENSURE_KATEX__'
	},
	{
		label: 'infoview CSS',
		file: join(tmpDir, 'infoview-css.js'),
		hint: 'node tools/build-infoview.mjs'
	},
	{
		label: 'infoview',
		file: join(tmpDir, 'infoview.js'),
		hint: 'node tools/build-infoview.mjs',
		// 惰性：这份 bundle 在求值时就摸 document（建 style 元素、探 ResizeObserver），
		// 顶层执行会让「只是想加载插件」的环境也被迫有完整 DOM。所以包进函数，
		// 等真要挂 infoview 时由 ensureInfoviewBundle() 触发一次。
		lazy: 'ensureInfoviewBundle',
		lazyGlobal: '__DCH_INFOVIEW__'
	}
];
const OUTPUT = join(packageRoot, 'lib', 'client.js');
const BUNDLE_ID = 'dsh-lean4';

/** 顶层声明：只认行首的 const/let/var/function/class，够用于我们自己的源码。 */
const DECLARATION = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * 剥掉模块语法。
 *
 * `export default` 我们不使用；`export {` 也不使用。剩下的只有 `export ` 前缀和
 * 单行 `import …`（本仓库约定 import 不跨行）。
 */
function strip(source, file) {
	const lines = source.split('\n');
	const kept = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
			if (!/[;'"]\s*$/.test(trimmed)) {
				throw new Error(`${file}: 发现跨行或多行的 import，内联器无法安全剥离：${trimmed}`);
			}
			continue;
		}
		if (trimmed.startsWith('export default ')) throw new Error(`${file}: 内联器不支持 export default`);
		kept.push(line.replace(/^(\s*)export\s+(?=(?:const|let|var|function|class|async)\b)/, '$1'));
	}
	return kept.join('\n');
}

const declarations = new Map();
const chunks = [];

for (const relative of SOURCES) {
	const absolute = join(packageRoot, relative);
	const body = strip(readFileSync(absolute, 'utf8'), relative);
	for (const line of body.split('\n')) {
		const matched = DECLARATION.exec(line);
		if (matched === null) continue;
		const name = matched[1];
		if (declarations.has(name)) {
			throw new Error(`顶层声明重名：${name}（${declarations.get(name)} 与 ${relative}）`);
		}
		declarations.set(name, relative);
	}
	chunks.push(`// ---- ${relative} ----\n${body.trimEnd()}\n`);
}

const vendorParts = [];
const lazyParts = new Map();
let vendorChars = 0;
for (const entry of VENDORS) {
	if (!existsSync(entry.file)) {
		throw new Error(`缺少 ${entry.label} 产物：${entry.file}，先跑 ${entry.hint}`);
	}
	const raw = readFileSync(entry.file, 'utf8');
	vendorChars += raw.length;
	const body = raw
		.split('\n')
		.filter((line) => !line.startsWith('//# sourceMappingURL='))
		.join('\n')
		.trimEnd();
	const section = `// ---- vendor: ${entry.label} (${raw.length} 字符) ----\n${body}\n`;
	if (entry.lazy === undefined) {
		vendorParts.push(section);
	} else {
		lazyParts.set(entry, section);
	}
}

/** 惰性 vendor：包成一个具名函数，只在首次需要时求值，并缓存结果。 */
/*
 * 缓存变量必须和「返回值」分开：第一版把哨兵值本身当缓存（`Once = globalThis`），
 * 第二次调用直接返回 `globalThis`——它没有 `renderInfoview`，面板就报
 * 「infoview 模块缺少 renderInfoview」。React effect 双跑很容易踩到。
 *
 * `lazyGlobal` 是这份 vendor 求值后自己挂到 globalThis 上的名字（katex 挂
 * `__DCH_KATEX__`、infoview 挂 `__DCH_INFOVIEW__`）；`accessor` 是我们额外暴露给
 * src/ 源码的函数名——markdown-lite 用 `globalThis.__DCH_ENSURE_KATEX__()` 触发求值，
 * 这样它单独在 Node 里跑测试时不依赖构建产物。
 */
const lazySections = [...lazyParts.entries()]
	.map(([entry, section]) => {
		const name = entry.lazy;
		const globalName = entry.lazyGlobal;
		const lines = [
			`let ${name}Cache;`,
			`function ${name}() {`,
			`  if (${name}Cache !== undefined) return ${name}Cache;`,
			`  ${name}Cache = null;`,
			section,
			`  const loaded = globalThis.${globalName};`,
			`  ${name}Cache = typeof loaded === 'object' && loaded !== null ? loaded : null;`,
			`  return ${name}Cache;`,
			`}`,
		];
		if (entry.accessor !== undefined) {
			lines.push(`globalThis.${entry.accessor} = ${name};`);
		}
		return lines.join('\n');
	})
	.join('\n');

const vendor = vendorParts.join('\n').trimEnd();

const output = `// 由 tools/build-client.mjs 生成，请勿手改。
// 本文件是构建产物，聚合了多种许可的组件：本项目自有源码为 MPL-2.0；对勾图标素材（Apache-2.0）
// 与 @leanprover/infoview（Apache-2.0）；CodeMirror 与 KaTeX（MIT）。各组件的许可见 THIRD-PARTY-NOTICES.md。
// 源文件：${SOURCES.join(' → ')}，前置 vendor：${VENDORS.map((entry) => entry.label).join(' + ')}（${vendorChars} 字符）。
(function () {
${vendor}
${lazySections}
${chunks.join('\n')}
window.__ModuleLoader__.load({
  id: ${JSON.stringify(BUNDLE_ID)},
  factory: (require) => createClientBody(require),
});
})();
`;

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, output, 'utf8');

const bytes = Buffer.byteLength(output, 'utf8');
console.log(`lib/client.js: ${bytes} 字节 / ${declarations.size} 个自有顶层声明 / vendor ${vendorChars} 字符`);
