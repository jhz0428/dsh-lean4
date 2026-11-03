// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 样式：编辑器外观、状态提示、冲突横幅。
//
// 全部通过 `--dle-*` 变量取值，变量本身映射到宿主的 `--shiki-token-*`（DSH 的
// css-variables 主题）并带回退色。这样：宿主换主题 → 高亮跟着变；没有 shiki 变量
// （或插件跑在别的壳里）→ 落到 One-Dark 家族，不会白底白字。

export const STYLE_ID = 'dsh-lean4-style';

export const STYLE_TEXT = `
:root {
  --dle-foreground: var(--shiki-foreground, #d4d4d4);
  --dle-comment: var(--shiki-token-comment, #7f848e);
  --dle-keyword: var(--shiki-token-keyword, #c678dd);
  --dle-string: var(--shiki-token-string-expression, var(--shiki-token-string, #98c379));
  --dle-constant: var(--shiki-token-constant, #d19a66);
  --dle-type: var(--shiki-token-parameter, #e5c07b);
  --dle-function: var(--shiki-token-function, #61afef);
  --dle-variable: var(--shiki-token-string, #e06c75);
  --dle-operator: var(--shiki-token-punctuation, #56b6c2);
  --dle-invalid: #e06c75;
  --dle-gutter: var(--shiki-token-comment, color-mix(in srgb, currentColor 45%, transparent));
}

.dle-host {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.dle-host .cm-editor {
  flex: 1 1 auto;
  min-height: 0;
}

/* 左栏：编辑器自己撑满，右栏是信息面板。 */
.dle-editor {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.dle-editor .cm-editor {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
}

.dle-notice {
  padding: 16px;
  font: 12.5px/1.7 var(--dsw-font-markdown-code-block, ui-monospace, monospace);
  color: var(--dle-comment);
  white-space: pre-wrap;
}

.dle-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  background: color-mix(in srgb, #e5c07b 14%, transparent);
  color: var(--dle-foreground);
}

.dle-banner[data-kind='failed'] {
  background: color-mix(in srgb, #e06c75 16%, transparent);
}

.dle-banner-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dle-banner button {
  flex: 0 0 auto;
  padding: 2px 8px;
  font-size: 11px;
  color: inherit;
  background: color-mix(in srgb, currentColor 10%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 5px;
  cursor: pointer;
}

.dle-banner button:hover {
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.dle-status {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 2px 10px 4px;
  font-size: 11px;
  color: var(--dle-comment);
  min-height: 16px;
}

.dle-status-lean {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.dle-status-lean[data-state='failed'] {
  color: #e06c75;
}

.dle-status-lean button {
  border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0 5px;
  cursor: pointer;
}

.dle-status-lean button:hover {
  background: color-mix(in srgb, currentColor 15%, transparent);
}

/* 目标面板：贴在编辑器下方，超长时自己滚动，不挤压编辑区。 */
.dle-goal {
  flex: 0 0 auto;
  max-height: 40%;
  overflow: auto;
  border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  padding: 6px 10px 8px;
  font-size: 12px;
}

.dle-goal-head {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dle-comment);
  margin-bottom: 4px;
}

.dle-goal-text {
  margin: 0 0 6px;
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dle-foreground, inherit);
}

/* 悬停提示：底色由 CodeMirror 的 .cm-tooltip 主题给（见 src/editor.js），
   这里只管内部排版，别再自带背景色 —— 否则深色面板上会出现一块白底。 */
.dle-hover {
  max-width: 560px;
  max-height: 340px;
  overflow: auto;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: inherit;
}

.dle-hover-code {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: 4px;
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre-wrap;
  color: var(--dle-type, #e5c07b);
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.dle-hover-code:last-child {
  margin-bottom: 0;
}

.dle-hover-text {
  color: inherit;
  opacity: 0.92;
}

.dle-hover-text + .dle-hover-text {
  margin-top: 6px;
}

.dle-hover a {
  color: var(--dle-function, #61afef);
  text-decoration: underline;
}

/* 诊断：gutter 里的点与波浪线用主题的错误色，但别抢注释的灰。 */
.dle-host .cm-lintRange-error {
  text-decoration: underline wavy #e06c75;
  text-underline-offset: 2px;
}

.dle-host .cm-lintRange-warning {
  text-decoration: underline wavy #e5c07b;
  text-underline-offset: 2px;
}

/* 编辑器 + 右侧信息面板的横向布局。 */
.dle-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.dle-side {
  display: flex;
  flex-direction: column;
  flex: 0 0 38%;
  min-width: 240px;
  max-width: 560px;
  min-height: 0;
  border-left: 1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.28));
  background: var(--dsw-alias-bg-base, transparent);
  overflow: hidden;
}

.dle-side[data-open='false'] {
  display: none;
}

.dle-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-text-secondary, #9aa0a6);
  border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.2));
}

.dle-side-note {
  font-weight: 400;
  opacity: 0.75;
}

/* 页签条：目标 / 大纲 / 引用 / 建议 / 设置。 */
.dle-side-tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}

.dle-side-tab {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  opacity: 0.7;
  cursor: pointer;
}

.dle-side-tab[data-active='true'] {
  opacity: 1;
  border-bottom-color: var(--dle-accent, #3794ff);
}

.dle-side-tab:hover {
  opacity: 1;
}

/* 页签内容区：infoview 之下的附加面板，最多占半栏，超出滚动。 */
.dle-pane {
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  max-height: 46%;
  overflow: auto;
  padding: 6px 8px 8px;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}

.dle-pane-title {
  font-size: 11px;
  opacity: 0.7;
}

.dle-pane-input {
  flex: 0 0 auto;
  padding: 3px 6px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11px;
}

.dle-pane-list {
  display: flex;
  flex-direction: column;
}

.dle-pane-row {
  display: flex;
  gap: 6px;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.dle-pane-row[data-depth='1'] {
  padding-left: 14px;
  opacity: 0.85;
}

.dle-pane-row[data-local='false'] {
  opacity: 0.7;
}

.dle-pane-row:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.dle-pane-row-line {
  flex: 0 0 auto;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}

.dle-side-action {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.dle-side-action:hover {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

/* 「建议」（Try this）条目。 */
.dle-suggest {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 4px 2px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent);
}

.dle-suggest-title {
  flex: 1 1 auto;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
}

/* infoview 设置区的开关。 */
.dle-toggle {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  line-height: 1.7;
}

.dle-toggle input[type='checkbox'] {
  margin: 0;
}

.dle-toggle-field {
  justify-content: space-between;
}

.dle-toggle-field input,
.dle-toggle-field select {
  max-width: 55%;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: color-mix(in srgb, currentColor 6%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11px;
}

.dle-side-error {
  flex: 0 0 auto;
  margin: 6px 10px 0;
  padding: 5px 8px;
  font-size: 11px;
  line-height: 1.5;
  border-radius: 4px;
  color: var(--dle-invalid, #e06c75);
  background: color-mix(in srgb, var(--dle-invalid, #e06c75) 12%, transparent);
  white-space: pre-wrap;
  word-break: break-word;
}

.dle-side-hint {
  flex: 0 0 auto;
  padding: 12px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-text-secondary, #9aa0a6);
  white-space: pre-wrap;
}

/* 官方 infoview 的样式表通篇用 --vscode-* 变量，而我们不是 VS Code。
   不补这一层，它的字色/底色/边框都会退化成「无效值 → unset」，
   看上去就像「面板是空的」。这里把常用的一批映射到 DSH 的令牌上。 */
.dle-infoview {
  --vscode-editor-background: var(--dsw-alias-bg-base, transparent);
  --vscode-editor-foreground: var(--dsw-alias-text-primary, #d4d4d4);
  --vscode-editor-font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
  --vscode-editor-font-size: 12.5px;
  --vscode-font-family: var(--dsw-font-sans, system-ui, sans-serif);
  --vscode-font-size: 12.5px;
  --vscode-panel-background: var(--dsw-alias-bg-base, transparent);
  --vscode-sideBar-background: var(--dsw-alias-bg-base, transparent);
  --vscode-editorWidget-background: var(--dsw-alias-bg-elevated, #252526);
  --vscode-editorWidget-border: var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.28));
  --vscode-descriptionForeground: var(--dsw-alias-text-secondary, #9aa0a6);
  --vscode-errorForeground: var(--dle-invalid, #e06c75);
  --vscode-editorError-foreground: var(--dle-invalid, #e06c75);
  --vscode-editorWarning-foreground: #e5c07b;
  --vscode-editorInfo-foreground: var(--dle-function, #61afef);
  --vscode-textLink-foreground: var(--dle-function, #61afef);
  --vscode-contrastBorder: transparent;
  --vscode-focusBorder: var(--dle-function, #61afef);
  --vscode-button-background: var(--dsw-alias-bg-elevated, #0e639c);
  --vscode-button-foreground: var(--dsw-alias-text-primary, #ffffff);
  --vscode-button-hoverBackground: color-mix(in srgb, var(--dle-function, #61afef) 30%, transparent);
  --vscode-badge-background: color-mix(in srgb, currentColor 18%, transparent);
  --vscode-badge-foreground: var(--dsw-alias-text-primary, #ffffff);
  --vscode-progressBar-background: var(--dle-function, #61afef);
  --vscode-input-background: color-mix(in srgb, currentColor 8%, transparent);
  --vscode-input-foreground: var(--dsw-alias-text-primary, #d4d4d4);
  --vscode-input-border: var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.4));
  color: var(--vscode-editor-foreground);
}

/* 官方 infoview：让它自己撑满右栏并内部滚动。 */
.dle-infoview {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  font-size: 12px;
}

.dle-infoview[data-ready='false'] {
  opacity: 0;
  pointer-events: none;
}

.dle-infoview > div {
  height: 100%;
  min-height: 0;
}

.dle-infoview .font-code {
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
}

/*
 * 官方 infoview 自带的蓝色「Restart File」按钮：形状与配色都照搬 VS Code 的
 * --vscode-button-* 变量，在本界面里既突兀又和我们状态栏的「重启」重复。
 * 每个打开的 .lean 文件都占一行，点击效果就是 api.restartFile()，
 * 我们用状态栏那个按钮覆盖同一功能，因此这里直接隐藏。
 */
.dle-infoview .restart-file-button {
  display: none;
}

/* 状态栏上的面板开关。 */
.dle-status-side {
  margin-left: auto;
}

/* 右键菜单：浮在编辑器上，跟随 .dle-host 的定位。 */
.dle-menu {
  position: absolute;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 168px;
  padding: 4px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.28));
  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, #1e1e1e));
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}

.dle-menu-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--dle-foreground, inherit);
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.dle-menu-item:hover {
  background: color-mix(in srgb, currentColor 14%, transparent);
}

/* 内联渲染的文档注释块：左侧一条强调线，观感更接近「文档」而不是代码。
 *
 * ⚠️ 垂直方向**不许有 margin**。这块 DOM 是 .cm-content 的直接子节点，CodeMirror
 * 用 getBoundingClientRect().height 量它来维护高度图（height map）；margin 不在
 * rect 里，会被漏算——每块少算 margin-top+margin-bottom，累积起来就是「渲染块与
 * 行号垂直错位、行号栏整体歪掉、方向键上下移动跨错行」。上下留白一律折进 padding。
 * 水平 margin 不参与高度图，可以保留。 */
.dle-doc {
  display: block;
  margin: 0 10px 0 2px;
  padding: 14px 14px 16px 16px;
  border-left: 2px solid var(--dle-doc-accent, color-mix(in srgb, currentColor 26%, transparent));
  border-radius: 6px;
  background: var(--dle-doc-bg, color-mix(in srgb, currentColor 4%, transparent));
  font-family: var(--dsw-font-markdown-body, inherit);
  font-size: 13px;
  /* 行高按元素给，标题/代码块/表格各自不同高——这里只留兜底值。 */
  line-height: 1.5;
  white-space: normal;
  cursor: text;
}

.dle-doc[data-kind='module'] {
  border-left-style: dashed;
}

.dle-doc[data-failed='true'] {
  opacity: 0.75;
}

.dle-doc-body > *:first-child {
  margin-top: 0;
}

.dle-doc-body > *:last-child {
  margin-bottom: 0;
}

.dle-doc-body p {
  margin: 0.55em 0;
  line-height: 1.7;
}

.dle-doc-body h1,
.dle-doc-body h2,
.dle-doc-body h3,
.dle-doc-body h4,
.dle-doc-body h5,
.dle-doc-body h6 {
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: 0.01em;
}

.dle-doc-body h1 {
  font-size: 1.5em;
  margin: 0.85em 0 0.45em;
}

.dle-doc-body h2 {
  font-size: 1.28em;
  margin: 0.8em 0 0.4em;
}

.dle-doc-body h3 {
  font-size: 1.13em;
  margin: 0.7em 0 0.35em;
}

.dle-doc-body h4,
.dle-doc-body h5,
.dle-doc-body h6 {
  font-size: 1em;
  margin: 0.6em 0 0.3em;
}

.dle-doc-body ul,
.dle-doc-body ol {
  margin: 0.45em 0;
  padding-left: 1.5em;
}

.dle-doc-body li {
  line-height: 1.65;
  margin: 0.16em 0;
}

.dle-doc-body li > ul,
.dle-doc-body li > ol {
  margin: 0.12em 0;
}

.dle-doc-body blockquote {
  margin: 0.55em 0;
  padding: 0.1em 0 0.1em 0.9em;
  border-left: 2px solid var(--dle-doc-accent, color-mix(in srgb, currentColor 22%, transparent));
  opacity: 0.92;
}

.dle-doc-body hr {
  margin: 1em 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
}

.dle-doc-body a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.dle-doc-body code {
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
  font-size: 0.9em;
  padding: 0.1em 0.34em;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 9%, transparent);
}

.dle-doc-body pre {
  margin: 0.6em 0;
  padding: 10px 12px;
  border-radius: 6px;
  overflow-x: auto;
  background: color-mix(in srgb, currentColor 7%, transparent);
  line-height: 1.55;
}

.dle-doc-body pre code {
  padding: 0;
  border-radius: 0;
  background: transparent;
  font-size: 0.92em;
}

.dle-doc-body table {
  margin: 0.6em 0;
  border-collapse: collapse;
  font-size: 0.95em;
}

.dle-doc-body th,
.dle-doc-body td {
  padding: 0.32em 0.62em;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  line-height: 1.5;
}

.dle-doc-body img {
  max-width: 100%;
  height: auto;
}

.dle-doc-body .katex-display {
  margin: 0.6em 0;
  overflow-x: auto;
  overflow-y: hidden;
}

/* 没有 KaTeX（或公式写坏）时的退化样式：保留原文，但不假装是公式。 */
.dle-doc-body .dle-math-raw {
  padding: 0 0.2em;
  border-radius: 3px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
  font-size: 0.92em;
  white-space: pre-wrap;
  word-break: break-word;
}

.dle-doc-body .dle-math-error {
  border-bottom: 1px dashed color-mix(in srgb, #e06c75 60%, transparent);
  color: #e06c75;
}

.dle-doc-raw {
  margin: 0;
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  opacity: 0.85;
}

/* 行号栏左侧的「证明完成」对勾（对应 vscode-lean4 的 GoalsAccomplished 装饰）。 */
.dle-proven-gutter {
  padding-left: 2px;
  padding-right: 2px;
  min-width: 20px;
}

.dle-proven {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--dle-proven, #3794ff);
  line-height: 1;
  cursor: default;
}

.dle-proven svg {
  display: block;
  width: 16px;
  height: 16px;
}

/* 「正在处理」与「证明完成」共用一列，用颜色区分：处理中是中性灰，别抢注意力。 */
.dle-proven-busy {
  color: color-mix(in srgb, currentColor 45%, transparent);
}

.dle-status-doc {
  border: none;
  padding: 0 6px;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  opacity: 0.7;
  cursor: pointer;
  white-space: nowrap;
}

.dle-status-doc:hover {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.dle-status-doc[data-on='true'] {
  opacity: 1;
}

.dle-status-note {
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
`;

/** 把样式塞进文档一次。多次激活（HMR）靠 id 去重，不会堆叠。 */
export function insertStyle(doc) {
	if (doc === undefined || doc === null) return;
	if (doc.getElementById(STYLE_ID) !== null) return;
	const element = doc.createElement('style');
	element.id = STYLE_ID;
	element.textContent = STYLE_TEXT;
	doc.head.appendChild(element);
}
