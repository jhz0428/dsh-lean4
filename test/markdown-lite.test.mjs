// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// markdown-lite：Lean 文档注释用的最小 markdown 渲染器。
//
// 这套断言钉的是「注释到底渲染成了什么 HTML」——真机上曾经因为借用宿主的
// MarkdownText 组件（需要它自己的 provider 上下文）而整块退化成纯文本，
// 所以这里逐条验证输出结构，而不是只看「有没有产生元素」。

import assert from 'node:assert/strict';
import { escapeHtml, renderInline, renderMarkdown } from '../src/markdown-lite.js';

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

test('escapeHtml 转义五类字符', () => {
	assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('标题按层级输出', () => {
	assert.equal(renderMarkdown('# 一级'), '<h1>一级</h1>');
	assert.equal(renderMarkdown('### 三级'), '<h3>三级</h3>');
});

test('标题后面的 # 被吃掉', () => {
	assert.equal(renderMarkdown('## 定理与证明 ##'), '<h2>定理与证明</h2>');
});

test('段落连成一段，软换行按空格合并', () => {
	assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行 第二行</p>');
});

test('空行分段', () => {
	assert.equal(renderMarkdown('a\n\nb'), '<p>a</p>\n<p>b</p>');
});

test('行内代码不被当强调处理', () => {
	assert.equal(renderInline('`*x*` 是斜体源码'), '<code>*x*</code> 是斜体源码');
});

test('加粗、斜体、删除线', () => {
	assert.equal(renderInline('**粗** 和 *斜* 和 ~~删~~'), '<strong>粗</strong> 和 <em>斜</em> 和 <del>删</del>');
});

test('链接带 target 与 rel', () => {
	assert.equal(
		renderInline('[文档](https://x.dev/a)'),
		'<a href="https://x.dev/a" target="_blank" rel="noreferrer noopener">文档</a>'
	);
});

test('图片', () => {
	assert.equal(renderInline('![图](a.png)'), '<img src="a.png" alt="图">');
});

test('正文里的尖括号被转义（不会注入 HTML）', () => {
	assert.equal(renderMarkdown('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});

test('围栏代码块保留原文并按语言加类', () => {
	const source = ['```lean', 'def a := 1', '```'].join('\n');
	assert.equal(renderMarkdown(source), '<pre><code class="language-lean">def a := 1</code></pre>');
});

test('代码块里的 markdown 不被解析', () => {
	const source = ['```', '# 不是标题', '**不是粗体**', '```'].join('\n');
	assert.equal(renderMarkdown(source), '<pre><code># 不是标题\n**不是粗体**</code></pre>');
});

test('未闭合的围栏吃到结尾', () => {
	assert.equal(renderMarkdown('```\na\nb'), '<pre><code>a\nb</code></pre>');
});

test('无序列表', () => {
	assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
});

test('有序列表', () => {
	assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});

test('嵌套列表按缩进分层', () => {
	assert.equal(
		renderMarkdown('- a\n  - a1\n- b'),
		'<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>'
	);
});

test('引用内的块级结构递归渲染', () => {
	assert.equal(renderMarkdown('> ## 标题'), '<blockquote><h2>标题</h2></blockquote>');
});

test('分隔线', () => {
	assert.equal(renderMarkdown('---'), '<hr>');
});

test('表格', () => {
	const source = ['| 名称 | 作用 |', '| --- | --- |', '| size | 节点数 |'].join('\n');
	assert.equal(
		renderMarkdown(source),
		'<table><thead><tr><th>名称</th><th>作用</th></tr></thead><tbody><tr><td>size</td><td>节点数</td></tr></tbody></table>'
	);
});

test('CRLF 归一化', () => {
	assert.equal(renderMarkdown('a\r\n\r\nb'), '<p>a</p>\n<p>b</p>');
});

test('空输入返回空串', () => {
	assert.equal(renderMarkdown(''), '');
	assert.equal(renderMarkdown('   \n\n '), '');
});

test('真实文档注释里的典型内容', () => {
	const source = [
		'## 2. 简单的定理与证明',
		'',
		'线性算术可以直接交给 `omega`。',
		'',
		'- `rfl`：定义相等',
		'- `omega`：线性算术',
	].join('\n');
	const html = renderMarkdown(source);
	assert.match(html, /<h2>2\. 简单的定理与证明<\/h2>/);
	assert.match(html, /<code>omega<\/code>/);
	assert.match(html, /<ul><li><code>rfl<\/code>：定义相等<\/li>/);
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
console.log(`\nmarkdown-lite: ${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
