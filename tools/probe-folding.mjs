// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 验证 A2/A4 依赖的 LSP 能力在真 `lean --server` 上确实可用：
// 折叠段（含 `kind: 'proof'`）、文件符号、引用、全项目符号。
//
//   node tools/probe-folding.mjs [file.lean]

import { resolve } from 'node:path';
import { createChecker, findToken, startProbeServer } from './probe-support.mjs';

const target =
	process.argv[2] === undefined
		? resolve(import.meta.dirname, '..', '..', '..', '..', '..', '001.lean')
		: resolve(process.argv[2]);

const { check, report } = createChecker();
const { server, lines, logLines } = await startProbeServer(target);

// ---------------------------------------------------------------- 折叠
const ranges = await server.foldingRanges(target);
const kinds = [...new Set(ranges.map((item) => item.kind))].sort();
console.log(`foldingRange: ${ranges.length} 段；kind=${JSON.stringify(kinds)}`);
check('foldingRange 返回非空', ranges.length > 0, '空数组');
check(
	'所有段都 endLine > startLine',
	ranges.every((item) => item.endLine > item.startLine),
	JSON.stringify(ranges.slice(0, 3)),
);
/* 实测结论（写进 docs）：Lean 4.35 的 `FoldingRangeKind` 只有
   comment / imports / region 三种，**从来不发 'proof'**。上游 vscode-lean4 的
   `isProof` 判据因此永远为假 —— 「折叠所有证明」必须由客户端按语法自己判断。 */
check(
	'kind 只出现 comment/imports/region',
	kinds.every((kind) => kind === 'comment' || kind === 'imports' || kind === 'region'),
	JSON.stringify(kinds),
);
check('不去指望服务器发 proof', ranges.every((item) => item.isProof === false));

/* 挑一条带 `by` 的定理，它的证明段应当覆盖到 `omega` 那一行。 */
const theoremLine = findToken(lines, 'theorem omega_example').line;
const covering = ranges.find((item) => item.startLine <= theoremLine && item.endLine >= theoremLine + 1);
console.log(
	`      theorem@${theoremLine + 1} 被覆盖：${covering === undefined ? '否' : `${covering.startLine + 1}..${covering.endLine + 1} kind=${covering.kind}`}`,
);
check('定理的 by 段能命中一个折叠区间', covering !== undefined);

/* 客户端按行首关键字判「这是不是证明」的启发式，在这里先验一遍可行性。 */
const THEOREM_START = /^(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|partial|unsafe|local)\s+)*(?:theorem|lemma|example)\b/;
const theoremRanges = ranges.filter((item) => THEOREM_START.test(lines[item.startLine] ?? ''));
console.log(
	`      行首是 theorem/lemma/example 的段：${theoremRanges.length} 个 → ${theoremRanges
		.map((item) => `${item.startLine + 1}:${(lines[item.startLine] ?? '').trim().slice(0, 40)}`)
		.join(' | ')}`,
);
check('启发式能认出多行证明段', theoremRanges.length >= 2, `只有 ${theoremRanges.length} 个`);
check(
	'认出的段确实跨多行',
	theoremRanges.every((item) => item.endLine > item.startLine),
);
/* 单行定理 Lean 根本不发 range（没有可折叠的结构），「折叠所有证明」对它是空操作。 */
check(
	'单行定理没有专属折叠区间（符合预期）',
	!ranges.some((item) => item.startLine === theoremLine),
	`line ${theoremLine + 1} 竟然有区间`,
);

// ---------------------------------------------------------------- 文件符号
const symbols = await server.documentSymbols(target);
const names = symbols.map((item) => item.name);
console.log(`documentSymbol: ${symbols.length} 个；前几个：${names.slice(0, 6).join(', ')}`);
check('documentSymbol 返回非空', symbols.length > 0);
check('符号里能查到定义的函数名', names.includes('double'), names.slice(0, 12).join(','));
check(
	'符号都带 range',
	symbols.every((item) => item.range?.start !== undefined),
);

// ---------------------------------------------------------------- 引用
const sizeToken = findToken(lines, 'def size');
const references = await server.references(target, {
	line: sizeToken.line,
	character: sizeToken.character + 5,
});
console.log(`references: ${references.length} 处`);
check('references 至少返回定义本身', references.length > 0, '空数组');
check(
	'引用都指向本文件或别的 .lean',
	references.every((item) => typeof item.uri === 'string' && item.range !== null),
);

// ---------------------------------------------------------------- 全项目符号
const workspace = await server.workspaceSymbols('double', 20);
console.log(`workspace/symbol("double"): ${workspace.length} 个`);
check('workspace/symbol 有结果', workspace.length > 0, '空数组（服务器可能不支持，工具需要兜底）');
check(
	'符号带路径或 uri',
	workspace.every((item) => typeof item.uri === 'string'),
);

server.dispose();
report(logLines);
