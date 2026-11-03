// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// markdown-lite 的数学渲染（LaTeX → KaTeX）。
//
// 这些断言钉的是「注释里的公式到底有没有被渲染」以及各种退化路径：没有 KaTeX、
// 公式写坏、公式没闭合、公式在代码块里。真机第一版完全没有数学支持，`$x^2$`
// 原样显示——所以这里既能证明「能用」，也能证明「不会因为公式而炸掉整段注释」。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { escapeHtml, renderInline, renderMarkdown, renderMath } from '../src/markdown-lite.js';

/* 载入构建产物 work/tmp/katex.js，模拟浏览器里 build-client 提供的惰性 vendor。 */
const KATEX_URL = new URL('../work/tmp/katex.js', import.meta.url);
if (!existsSync(fileURLToPath(KATEX_URL))) {
	console.error('缺少 work/tmp/katex.js —— 先跑 `npm run build`（本测试要载入构建产物）。');
	process.exit(1);
}
vm.runInThisContext(readFileSync(KATEX_URL, 'utf8'));
assert.equal(typeof globalThis.__DCH_KATEX__?.renderToString, 'function', 'katex 产物应挂到 __DCH_KATEX__');

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

test('行内公式渲染成 .katex', () => {
	const html = renderMarkdown('Inline $x^2 + y^2 = z^2$ 结束');
	assert.match(html, /class="katex"/);
	assert.match(html, /annotation encoding="application\/x-tex">x\^2 \+ y\^2 = z\^2</);
	assert.match(html, /^<p>Inline <span class="katex">/);
	assert.match(html, /结束<\/p>$/);
});

test('单行块级公式渲染成 .katex-display', () => {
	const html = renderMarkdown('$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$');
	assert.match(html, /class="katex-display"/);
	assert.doesNotMatch(html, /\$\$/);
	assert.match(html, /<annotation encoding="application\/x-tex">\\sum_\{i=1\}\^\{n\}/);
});

test('跨行块级公式：定界符各占一行', () => {
	const html = renderMarkdown('段落\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n\n后面');
	assert.match(html, /class="katex-display"/);
	assert.doesNotMatch(html, /\$\$/);
	assert.match(html, /<p>段落<\/p>/);
	assert.match(html, /<p>后面<\/p>/);
	assert.match(html, /annotation encoding="application\/x-tex">\\int_0\^1 x\\,dx = \\frac\{1\}\{2\}</);
});

test('块级公式里的换行被吃掉，公式按整体渲染', () => {
	const html = renderMarkdown('$$\n\na + b\n\n$$');
	assert.match(html, /katex-display/);
	/* 空行不会把公式拆成两个块。 */
	assert.equal((html.match(/katex-display/g) ?? []).length, 1);
});

test('未闭合的块级公式退成普通段落，不吞后续内容', () => {
	const html = renderMarkdown('$$没闭合\n\n后面段落');
	assert.match(html, /没闭合/);
	assert.match(html, /后面段落/);
	assert.doesNotMatch(html, /katex-display/);
});

test('行内代码里的 $ 不会被当成公式', () => {
	const html = renderMarkdown('对比 `$x$` 与 $x$');
	assert.match(html, /<code>\$x\$<\/code>/);
	assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});

test('孤立 $ 保持原样', () => {
	const html = renderMarkdown('一个孤立的 $ 符号');
	assert.match(html, /\$ 符号/);
	assert.doesNotMatch(html, /class="katex"/);
});

test('没有空白包裹的中文与公式可以相邻', () => {
	const html = renderMarkdown('公式$x$紧随');
	assert.match(html, /class="katex"/);
	assert.match(html, /^<p>公式<span class="katex">/);
	assert.match(html, /<\/span>紧随<\/p>$/);
});

test('写坏的公式退成 katex-error，其余文字保留', () => {
	const html = renderMarkdown('坏公式 $\\frac{1}{$ 结束');
	assert.match(html, /katex-error/);
	assert.match(html, /坏公式/);
	assert.match(html, /结束/);
});

test('公式里的 HTML 不会变成真标签', () => {
	const html = renderMarkdown('$<script>alert(1)</script>$');
	assert.doesNotMatch(html, /<script>/);
});

test('公式在列表项里可用', () => {
	const html = renderMarkdown('- 第一项 $a+b$\n- 第二项 $c$');
	assert.match(html, /<li>第一项 <span class="katex">/);
	assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
});

test('公式在标题里可用', () => {
	const html = renderMarkdown('## 定理 $P \\to Q$');
	assert.match(html, /^<h2>定理 <span class="katex">/);
});

test('公式在表格单元里可用', () => {
	const html = renderMarkdown('| 记号 | 含义 |\n| --- | --- |\n| $\\alpha$ | 角 |');
	assert.match(html, /<td><span class="katex">/);
	assert.match(html, /<td>角<\/td>/);
});

test('星号强调与公式共存，不互相破坏', () => {
	const html = renderMarkdown('**粗** 与 $a*b$ 与 *斜*');
	assert.match(html, /<strong>粗<\/strong>/);
	assert.match(html, /<em>斜<\/em>/);
	assert.match(html, /class="katex"/);
});

test('公式里的下划线不会被当成斜体', () => {
	const html = renderMarkdown('$a_1 + b_2$');
	assert.doesNotMatch(html, /<em>/);
	assert.match(html, /class="katex"/);
});

test('没有 KaTeX 时退成 dle-math-raw 并保留原文', () => {
	const saved = globalThis.__DCH_KATEX__;
	delete globalThis.__DCH_KATEX__;
	try {
		const html = renderMarkdown('公式 $a+b$ 结束');
		assert.match(html, /class="dle-math-raw"/);
		assert.match(html, /a\+b/);
		assert.match(html, /结束/);
	} finally {
		globalThis.__DCH_KATEX__ = saved;
	}
});

test('renderMath：空串返回空串', () => {
	assert.equal(renderMath('   ', false), '');
	assert.equal(renderMath('', true), '');
});

test('renderMath：displayMode 影响输出结构', () => {
	assert.match(renderMath('a', false), /^<span class="katex">/);
	assert.match(renderMath('a', true), /^<span class="katex-display">/);
});

test('renderInline 单独调用也会渲染公式', () => {
	assert.match(renderInline('$a$'), /class="katex"/);
});

test('escapeHtml 仍然不碰公式之外的内容', () => {
	assert.equal(escapeHtml('<x>'), '&lt;x&gt;');
});

let failed = 0;
for (const { name, fn } of cases) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${name}`);
		console.log(`     ${error.message}`);
	}
}
console.log(`\nmarkdown-math: ${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
