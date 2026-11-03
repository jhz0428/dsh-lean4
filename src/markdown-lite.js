// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * 一个够用的 markdown → HTML 渲染器，零依赖、纯字符串。
 *
 * 为什么自己写：DSH 客户端的 `MarkdownText` 组件依赖它自己的
 * `MarkdownDelegateProvider` 上下文，脱离聊天树渲染会直接抛错（注释会退成纯文本）。
 * Lean 文档注释需要的语法面很窄——标题、段落、列表、代码块、行内代码、强调、链接、
 * 引用、表格、分隔线——自己实现反而稳定：不依赖宿主内部组件，也不往包里塞 markdown-it。
 *
 * 输出是**转义过的 HTML 字符串**，调用方用 innerHTML 挂到 `.dle-doc-body` 上。
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 文本转义。 */
export function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/*
 * LaTeX 公式。
 *
 * 三条约束决定了这里的写法：
 *   1. 数学必须在**转义之前**摘出来——转义会把 `$` 保持原样，但 `\` 变成普通文本后
 *      KaTeX 的 `\frac` 就废了；而且摘出来的原文要继续可见（不是 HTML 实体）。
 *   2. 行内 `$…$` 与块级 `$$…$$` 都要支持，块级还要能吃跨行（Lean 文档注释里
 *      display 公式经常写成多行）。
 *   3. 没有 KaTeX 时不能崩——退成 `<code class="dle-math-raw">` 显示原文，
 *      与「没装数学库」的观感一致，也不会让整段注释渲染失败。
 *
 * 与常见的自动渲染器不同，这里**不处理** `\(…\)` / `\[…\]`：Lean 注释里 `\[` 常出现
 * 在代码/正则片段中，误判代价比多支持一种写法高。
 */
const MATH_INLINE = /\$([^$\n]+?)\$/g;
const MATH_BLOCK = /^\s*\$\$\s*$/;

/**
 * 惰性取 KaTeX：`work/tmp/katex.js` 被 build-client 包成 `ensureKatex()`，
 * 只有真的出现公式时才求值那 27 万字符。
 *
 * @returns {{ renderToString: Function } | null}
 */
function katexApi() {
	const lazy = globalThis.__DCH_ENSURE_KATEX__;
	if (typeof lazy === 'function') {
		try {
			const loaded = lazy();
			if (loaded !== null && typeof loaded === 'object') return loaded;
		} catch {
			return null;
		}
	}
	const ready = globalThis.__DCH_KATEX__;
	return ready !== null && typeof ready === 'object' && typeof ready.renderToString === 'function' ? ready : null;
}

/**
 * 渲染一条公式。
 *
 * 与 DSH 自己的 `renderTexToReact` 同策略：先严格渲染（真正的语法错误要能看出来），
 * 再宽松重试（Lean 注释里的公式经常带宿主不认的宏），最后退成原文。
 *
 * @param {string} source LaTeX 原文（不含定界符）
 * @param {boolean} displayMode 是否块级
 * @returns {string} HTML
 */
export function renderMath(source, displayMode) {
	const tex = String(source).trim();
	if (tex === '') return '';
	const katex = katexApi();
	if (katex === null) return `<code class="dle-math-raw">${escapeHtml(tex)}</code>`;
	try {
		return katex.renderToString(tex, { displayMode: displayMode === true, throwOnError: true });
	} catch (fatal) {
		try {
			return katex.renderToString(tex, { displayMode: displayMode === true, strict: 'ignore', throwOnError: false });
		} catch {
			/* 两次都失败：把原文交给用户，别丢掉信息。 */
			const reason = fatal instanceof Error ? fatal.message : String(fatal);
			return `<code class="dle-math-raw dle-math-error" title="${escapeHtml(reason)}">${escapeHtml(tex)}</code>`;
		}
	}
}

/**
 * 把一段文本里的 `$…$` 换成公式，其余保持不变（不转义——调用方接着会转义）。
 *
 * 用占位符的办法与行内代码一致：先把公式抽成哨兵，等转义/强调/链接都做完了再把
 * HTML 塞回去，否则 KaTeX 输出里的 `<` `>` 会被自己的转义器打成实体。
 *
 * @param {string} text
 * @returns {{ text: string, maths: string[] }}
 */
function extractInlineMath(text) {
	const maths = [];
	const rest = String(text).replace(MATH_INLINE, (whole, body) => {
		const tex = body.trim();
		/* `$$` 之外的裸 `$` 常被当作美元符号：只有一个 `$` 或含空白的极端短串放过。 */
		if (tex === '') return whole;
		maths.push(renderMath(tex, false));
		return `\u0001${maths.length - 1}\u0001`;
	});
	return { text: rest, maths };
}

/** 把行内公式的哨兵换回 HTML。 */
function restoreInlineMath(html, maths) {
	if (maths.length === 0) return html;
	return html.replace(/\u0001(\d+)\u0001/g, (_, index) => maths[Number(index)] ?? '');
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/**
 * 行内语法：先摘出行内代码与公式，其余部分转义后再处理强调/链接/删除线。
 *
 * 顺序是有讲究的：代码在最前（代码里的 `$` 不该变成公式），公式紧随其后，
 * 然后才转义——转义之后 `\frac` 里的反斜杠就没了。
 *
 * @param {string} text 一行（或一段）行内 markdown
 * @returns {string} HTML
 */
export function renderInline(text) {
	const codes = [];
	let work = String(text).replace(/(`+)([^`]*?)\1/g, (_, __, body) => {
		codes.push(body.trim() === '' ? body : body);
		return `\u0000${codes.length - 1}\u0000`;
	});
	const math = extractInlineMath(work);
	work = escapeHtml(math.text);
	work = work.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
		(_, alt, src, title) => `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''}>`);
	work = work.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
		(_, label, href, title) => `<a href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noreferrer noopener">${label}</a>`);
	work = work.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
	work = work.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '<em>$2</em>');
	work = work.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
	work = restoreInlineMath(work, math.maths);
	work = work.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`);
	return work;
}

/** 把一段连续行合成一个段落（软换行按空格处理，与 markdown 一致）。 */
function paragraphHtml(lines) {
	return `<p>${renderInline(lines.map((line) => line.trim()).join(' ')).trim()}</p>`;
}

/** 解析表格的一行，返回去掉首尾空单元后的单元格数组。 */
function splitRow(line) {
	let row = line.trim();
	if (row.startsWith('|')) row = row.slice(1);
	if (row.endsWith('|')) row = row.slice(0, -1);
	return row.split('|').map((cell) => cell.trim());
}

/**
 * 列表：按缩进宽度决定层级（2 空格起步，1–3 空格也算下一级）。
 *
 * @param {string[]} lines 原始行
 * @param {number} start 起始下标
 * @returns {{ html: string, next: number }}
 */
function renderList(lines, start) {
	/* 注意：`match` 每次都返回新数组，不能靠 `===` 判断是哪条正则命中。 */
	const isBullet = BULLET.test(lines[start]);
	const first = isBullet ? lines[start].match(BULLET) : lines[start].match(ORDERED);
	const ordered = !isBullet;
	const baseIndent = first[1].length;
	const items = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === '') {
			const next = lines[index + 1];
			if (next === undefined || next.trim() === '') break;
			const follows = next.match(BULLET) ?? next.match(ORDERED);
			if (follows === null || follows[1].length < baseIndent) break;
			index += 1;
			continue;
		}
		const bullet = line.match(BULLET);
		const numbered = line.match(ORDERED);
		const match = bullet ?? numbered;
		if (match === null || match[1].length < baseIndent) break;
		const text = match[3];
		let item = renderInline(text);
		index += 1;
		/* 子列表：紧接着、缩进更深的同块行。 */
		const nextLine = lines[index];
		if (nextLine !== undefined) {
			const child = nextLine.match(BULLET) ?? nextLine.match(ORDERED);
			if (child !== null && child[1].length > baseIndent) {
				const nested = renderList(lines, index);
				item += nested.html;
				index = nested.next;
			}
		}
		/* 续行：缩进比本文更深、且不是新条目 → 并入当前条目。 */
		while (index < lines.length) {
			const continuation = lines[index];
			if (continuation.trim() === '') break;
			const startsItem = (continuation.match(BULLET) ?? continuation.match(ORDERED)) !== null;
			const indent = continuation.length - continuation.trimStart().length;
			if (startsItem || indent <= baseIndent) break;
			item += ` ${renderInline(continuation.trim())}`;
			index += 1;
		}
		items.push(`<li>${item}</li>`);
	}
	const tag = ordered ? 'ol' : 'ul';
	return { html: `<${tag}>${items.join('')}</${tag}>`, next: index };
}

/**
 * 块级解析。
 *
 * @param {string[]} lines 原始行
 * @returns {string} HTML
 */
function renderBlocks(lines) {
	const out = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === '') {
			index += 1;
			continue;
		}
		/* 块级公式：首行必须只有 `$$`，随后一直吃到下一个只有 `$$` 的行。 */
		if (MATH_BLOCK.test(line)) {
			const body = [];
			index += 1;
			let closed = false;
			while (index < lines.length) {
				if (MATH_BLOCK.test(lines[index])) {
					index += 1;
					closed = true;
					break;
				}
				body.push(lines[index]);
				index += 1;
			}
			/*
			 * 没闭合时不吞掉剩余内容：把 `$$` 当普通文本还回去，靠段落分支渲染。
			 * 注释里写了一半的公式很常见（边写边看），吞掉会让后半篇消失。
			 */
			if (!closed) {
				out.push(paragraphHtml([line, ...body]));
				continue;
			}
			out.push(renderMath(body.join('\n'), true));
			continue;
		}
		/* 单行块级公式：`$$ … $$` 挤在同一行。 */
		const inlineBlock = line.match(/^\s*\$\$(.+?)\$\$\s*$/);
		if (inlineBlock !== null) {
			out.push(renderMath(inlineBlock[1], true));
			index += 1;
			continue;
		}
		const fence = line.match(FENCE);
		if (fence !== null) {
			const marker = fence[1][0];
			const language = fence[2];
			const body = [];
			index += 1;
			while (index < lines.length) {
				const closing = lines[index].match(FENCE);
				if (closing !== null && closing[1][0] === marker) {
					index += 1;
					break;
				}
				body.push(lines[index]);
				index += 1;
			}
			const cls = language === '' ? '' : ` class="language-${escapeHtml(language)}"`;
			out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
			continue;
		}
		const heading = line.match(HEADING);
		if (heading !== null) {
			const level = heading[1].length;
			out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			index += 1;
			continue;
		}
		if (RULE.test(line)) {
			out.push('<hr>');
			index += 1;
			continue;
		}
		if (QUOTE.test(line)) {
			const quoted = [];
			while (index < lines.length) {
				const match = lines[index].match(QUOTE);
				if (match === null) break;
				quoted.push(match[1]);
				index += 1;
			}
			out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
			continue;
		}
		if ((line.match(BULLET) ?? line.match(ORDERED)) !== null) {
			const list = renderList(lines, index);
			out.push(list.html);
			index = list.next;
			continue;
		}
		/* 表格：本行含 | 且下一行是分隔行。 */
		if (line.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]) && lines[index + 1].includes('-')) {
			const header = splitRow(line);
			index += 2;
			const rows = [];
			while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
				rows.push(splitRow(lines[index]));
				index += 1;
			}
			const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
			const body = rows
				.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
				.join('');
			out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
			continue;
		}
		/* 段落：吃到空行或下一个块级起点。 */
		const paragraph = [];
		while (index < lines.length) {
			const current = lines[index];
			if (current.trim() === '') break;
			if (paragraph.length > 0) {
				if (FENCE.test(current) || HEADING.test(current) || RULE.test(current) || QUOTE.test(current)) break;
				if ((current.match(BULLET) ?? current.match(ORDERED)) !== null) break;
			}
			paragraph.push(current);
			index += 1;
		}
		if (paragraph.length > 0) out.push(paragraphHtml(paragraph));
	}
	return out.join('\n');
}

/**
 * 渲染整段 markdown（Lean 文档注释的正文）。
 *
 * @param {string} source 注释正文（已去掉 `/-!` `-/` 之类的标记）
 * @returns {string} HTML
 */
export function renderMarkdown(source) {
	if (typeof source !== 'string' || source.trim() === '') return '';
	return renderBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}
