// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 把一份 .lean 渲染成静态 HTML，用来肉眼检查配色。
//
// 不启动 DSH 也能看：颜色用的就是 style.js 里 `--dle-*` 变量在「没有 shiki 变量」时
// 的回退值，明暗两套都画一遍。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAN_SPEC } from '../src/lean-mode.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/** 与 style.js 的 `:root` 回退值一一对应。 */
const PALETTE = {
	dark: {
		foreground: '#d4d4d4',
		background: '#1e1e1e',
		comment: '#7f848e',
		keyword: '#c678dd',
		string: '#98c379',
		constant: '#d19a66',
		type: '#e5c07b',
		function: '#61afef',
		variable: '#e06c75',
		operator: '#56b6c2',
		gutter: '#5c6370',
		separator: '#2a2a2a'
	},
	light: {
		foreground: '#383a42',
		background: '#fafafa',
		comment: '#a0a1a7',
		keyword: '#a626a4',
		string: '#50a14f',
		constant: '#986801',
		type: '#c18401',
		function: '#4078f2',
		variable: '#e45649',
		operator: '#0184bc',
		gutter: '#9d9d9f',
		separator: '#e5e5e6'
	}
};

/** tag → 调色板键。与 editor.js 的 HighlightStyle 逐条对应。 */
const TAG_COLOR = {
	comment: 'comment',
	keyword: 'keyword',
	string: 'string',
	number: 'constant',
	typeName: 'type',
	'variableName.function': 'function',
	operator: 'operator'
};

function escapeHtml(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 用假的 StringStream 驱动分词器——与 CodeMirror 的驱动方式一致。 */
function tokenizeLine(text, state) {
	const stream = {
		string: text,
		pos: 0,
		eol() {
			return this.pos >= this.string.length;
		},
		next() {
			if (this.pos >= this.string.length) return undefined;
			this.pos += 1;
			return this.string[this.pos - 1];
		},
		peek() {
			return this.pos >= this.string.length ? undefined : this.string[this.pos];
		},
		eatSpace() {
			const start = this.pos;
			while (this.pos < this.string.length && /\s/.test(this.string[this.pos])) this.pos += 1;
			return this.pos > start;
		}
	};
	const segments = [];
	let guard = 0;
	while (!stream.eol()) {
		guard += 1;
		if (guard > text.length * 4 + 16) break;
		const before = stream.pos;
		const tag = LEAN_SPEC.token(stream, state);
		if (stream.pos <= before && !stream.eol()) stream.pos = before + 1;
		segments.push({ tag, text: text.slice(before, stream.pos) });
	}
	return segments;
}

function renderPane(lines, palette) {
	const state = LEAN_SPEC.startState();
	const rows = lines.map((line, index) => {
		const segments = tokenizeLine(line, state);
		const body = segments
			.map((segment) => {
				const key = segment.tag === null ? null : TAG_COLOR[segment.tag];
				const text = escapeHtml(segment.text);
				if (key === null || key === undefined) return text;
				const style = `color:${palette[key]}`;
				const extra = segment.tag === 'comment' ? ';font-style:italic' : '';
				return `<span style="${style}${extra}">${text}</span>`;
			})
			.join('') || '&nbsp;';
		return `<div class="line"><span class="no">${index + 1}</span><span class="code">${body}</span></div>`;
	});
	const used = new Set();
	for (const row of rows) for (const match of row.matchAll(/color:(#[0-9a-f]{6})/g)) used.add(match[1]);
	return `<div class="pane" style="color:${palette.foreground};background:${palette.background}">${rows.join('\n')}</div>`;
}

const source = process.argv[2];
const target = process.argv[3];
if (source === undefined || target === undefined) {
	console.error('用法：node tools/render-preview.mjs <input.lean> <output.html>');
	process.exit(1);
}

const text = readFileSync(resolve(source), 'utf8');
const lines = text.split(/\r?\n/);
const document = `<!doctype html>
<meta charset="utf-8">
<title>dsh-lean4 配色预览</title>
<style>
  body { margin: 0; padding: 24px; background: #14151a; font-family: system-ui, "Segoe UI", sans-serif; }
  h2 { color: #9aa0aa; font: 600 13px/1.6 system-ui, sans-serif; margin: 0 0 8px 2px; letter-spacing: .04em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .pane { border-radius: 10px; overflow: auto; max-height: 78vh;
          font: 12.5px/1.65 ui-monospace, "Cascadia Mono", Consolas, monospace; padding: 10px 0; }
  .line { display: flex; white-space: pre; }
  .no { flex: 0 0 auto; width: 3.2em; padding: 0 10px 0 8px; text-align: right;
        color: ${PALETTE.dark.gutter}; user-select: none; opacity: .75; }
  .code { flex: 1 1 auto; padding-right: 16px; }
  footer { color: #6b7280; font: 12px system-ui, sans-serif; margin-top: 14px; }
</style>
<h2>DARK（--dle-* 回退值）</h2>
<div class="grid">
  <div>${renderPane(lines, PALETTE.dark)}</div>
  <div>${renderPane(lines, PALETTE.light)}</div>
</div>
<footer>${lines.length} 行 · ${escapeHtml(source)} · 左＝暗色回退，右＝亮色回退</footer>
`;

mkdirSync(dirname(resolve(target)), { recursive: true });
writeFileSync(resolve(target), document, 'utf8');
console.log(`${target}: ${lines.length} 行已渲染`);
