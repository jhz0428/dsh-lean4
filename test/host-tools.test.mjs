// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Agent 工具的单元测试：纯函数 + 假 bridge，不 spawn Lean、不碰 DSH。
//
// 这里刻意断言的是「工具层自己的契约」：
//   - 1-based 参数必须转成 0-based 再交给宿主半（差一位是最常见的 off-by-one）；
//   - 静默诊断（isSilent）不能出现在结果里，但要计数；
//   - 宿主半的 {ok:false} 信封必须收成 {status:'error'}，不让异常冒出去。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLeanTools, LEAN_TOOL_NAMES } from '../src/host/tools.js';

/** 记录调用的假 bridge；`run` 可按 op 定制返回值。 */
function fakeBridge(responder = {}) {
	const calls = [];
	return {
		calls,
		resolvePath(raw) {
			if (typeof raw !== 'string' || raw.trim() === '') throw new Error('path 不能为空');
			return raw.startsWith('/') ? raw : `/proj/${raw}`;
		},
		async anchor() {
			calls.push({ kind: 'anchor' });
			return '/proj/001.lean';
		},
		async prepare(path, options) {
			calls.push({ kind: 'prepare', path, options });
			return { settled: true, waitedMs: 12, notes: [] };
		},
		async run(op, body) {
			calls.push({ kind: 'run', op, body });
			const responderFor = responder[op];
			return responderFor === undefined ? { ok: true, value: {} } : responderFor(body);
		},
	};
}

function toolsOf(responder) {
	const bridge = fakeBridge(responder);
	return { bridge, tools: createLeanTools(bridge), tool: (name) => createLeanTools(bridge).find((item) => item.name === name) };
}

const DIAGNOSTICS_VALUE = {
	state: 'ready',
	diagnostics: [
		{
			severity: 1,
			message: 'unknown identifier',
			code: 'unknownIdentifier',
			startLine: 2,
			startCharacter: 4,
			endLine: 2,
			endCharacter: 9,
		},
		{
			severity: 3,
			message: 'Goals accomplished!',
			startLine: 5,
			startCharacter: 0,
			endLine: 5,
			endCharacter: 1,
			leanTags: [2],
			isSilent: true,
		},
	],
	progress: [],
};

const cases = [];

cases.push({
	name: '九个工具名齐全、都有 lean_ 前缀且互不重复',
	fn() {
		assert.equal(LEAN_TOOL_NAMES.length, 9);
		assert.equal(new Set(LEAN_TOOL_NAMES).size, 9);
		for (const name of LEAN_TOOL_NAMES) assert.ok(name.startsWith('lean_'), name);
		const { tools } = toolsOf({});
		assert.deepEqual(tools.map((item) => item.name).sort(), [...LEAN_TOOL_NAMES].sort());
	},
});

cases.push({
	name: '每个工具的形状：parameters 是对象 schema、output.render 是函数、schema 是 oneOf',
	fn() {
		const { tools } = toolsOf({});
		for (const item of tools) {
			assert.equal(typeof item.description, 'string', item.name);
			assert.ok(item.description.length > 20, `${item.name} 的描述太短`);
			assert.equal(item.parameters.type, 'object', item.name);
			assert.equal(item.parameters.additionalProperties, false, item.name);
			assert.equal(typeof item.parameters.properties, 'object', item.name);
			assert.equal(typeof item.output.render, 'function', item.name);
			assert.equal(Array.isArray(item.output.schema.oneOf), true, item.name);
			assert.equal(item.output.schema.oneOf.length, 2, item.name);
			assert.equal(item.isConcurrencySafe(), false, item.name);
		}
	},
});

cases.push({
	name: '位置类工具的参数要求 path/line/character',
	fn() {
		const { tools } = toolsOf({});
		for (const name of ['lean_goal', 'lean_hover', 'lean_completion', 'lean_definition', 'lean_references', 'lean_code_actions']) {
			const item = tools.find((entry) => entry.name === name);
			assert.deepEqual([...item.parameters.required].sort(), ['character', 'line', 'path'], name);
			assert.equal(item.parameters.properties.line.type, 'integer', name);
		}
	},
});

cases.push({
	name: '诊断：静默装饰诊断被剔掉但计数，行号转 1 基',
	async fn() {
		const { tool } = toolsOf({ diagnostics: () => ({ ok: true, value: DIAGNOSTICS_VALUE }) });
		const value = await tool('lean_diagnostics').execute({ path: '001.lean' });
		assert.equal(value.status, 'ok');
		assert.equal(value.total, 2);
		assert.equal(value.silent, 1);
		assert.equal(value.diagnostics.length, 1);
		assert.equal(value.diagnostics[0].line, 3);
		assert.equal(value.diagnostics[0].character, 5);
		assert.equal(value.diagnostics[0].severity, 'error');
		assert.equal(value.diagnostics[0].code, 'unknownIdentifier');
		assert.equal(value.settled, true);
		assert.equal(value.state, 'ready');
	},
});

cases.push({
	name: '诊断渲染：一行摘要 + 每条一行，静默条数写在括号里',
	async fn() {
		const { tool } = toolsOf({ diagnostics: () => ({ ok: true, value: DIAGNOSTICS_VALUE }) });
		const item = tool('lean_diagnostics');
		const value = await item.execute({ path: '001.lean' });
		const rendered = item.output.render({ path: '001.lean' }, value)[0].text;
		assert.match(rendered, /^\/proj\/001\.lean: 1 error/);
		assert.match(rendered, /3:5 error: unknown identifier \[unknownIdentifier\]/);
		assert.match(rendered, /1 条静默装饰诊断已隐藏/);
		assert.match(rendered, /server ready/);
	},
});

cases.push({
	name: '诊断：severity=error 过滤掉其它级别',
	async fn() {
		const responder = {
			diagnostics: () => ({
				ok: true,
				value: {
					...DIAGNOSTICS_VALUE,
					diagnostics: [
						DIAGNOSTICS_VALUE.diagnostics[0],
						{ severity: 2, message: 'unused variable', startLine: 7, startCharacter: 0, endLine: 7, endCharacter: 3 },
					],
				},
			}),
		};
		const { tool } = toolsOf(responder);
		const value = await tool('lean_diagnostics').execute({ path: '001.lean', severity: 'error' });
		assert.equal(value.diagnostics.length, 1);
		assert.equal(value.diagnostics[0].severity, 'error');
	},
});

cases.push({
	name: '宿主半拒绝时收成 {status:error}，渲染出 code 与 message',
	async fn() {
		const { tool } = toolsOf({ hover: () => ({ ok: false, error: { code: 'lsp-failed', message: 'the Lean server exited' } }) });
		const item = tool('lean_hover');
		const value = await item.execute({ path: '001.lean', line: 3, character: 2 });
		assert.equal(value.status, 'error');
		assert.equal(value.code, 'lsp-failed');
		const rendered = item.output.render({}, value)[0].text;
		assert.equal(rendered, 'lsp-failed: the Lean server exited');
	},
});

cases.push({
	name: '1 基参数转成 0 基发给宿主半，结果再转回 1 基',
	async fn() {
		const seen = [];
		const { tool } = toolsOf({
			goal: (body) => {
				seen.push(body);
				return { ok: true, value: { goals: ['⊢ 2 + 2 = 4'] } };
			},
			termGoal: () => ({ ok: true, value: { text: '' } }),
		});
		const value = await tool('lean_goal').execute({ path: '001.lean', line: 12, character: 5 });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].line, 11);
		assert.equal(seen[0].character, 4);
		assert.equal(seen[0].path, '/proj/001.lean');
		assert.equal(value.line, 12);
		assert.equal(value.character, 5);
		assert.deepEqual(value.goals, ['⊢ 2 + 2 = 4']);
	},
});

cases.push({
	name: '非法的 1 基行号/列号直接拒绝，不打扰宿主半',
	async fn() {
		const { bridge, tool } = toolsOf({});
		for (const [line, character] of [[0, 1], [1, 0], [1.5, 1], [1, 'x']]) {
			const value = await tool('lean_hover').execute({ path: '001.lean', line, character });
			assert.equal(value.status, 'error', `${line},${character}`);
			assert.equal(value.code, 'invalid-args');
		}
		assert.equal(bridge.calls.filter((call) => call.kind === 'run').length, 0);
	},
});

cases.push({
	name: '悬停：空文本时给出「没有悬停信息」',
	async fn() {
		const item = toolsOf({ hover: () => ({ ok: true, value: null }) }).tool('lean_hover');
		const value = await item.execute({ path: '001.lean', line: 3, character: 2 });
		assert.equal(value.text, '');
		assert.match(item.output.render({ line: 3, character: 2 }, value)[0].text, /没有悬停信息/);
	},
});

cases.push({
	name: '悬停：有文本时原样返回 markdown',
	async fn() {
		const item = toolsOf({ hover: () => ({ ok: true, value: { text: '```lean\nDemo.two_add_two : 2 + 2 = 4\n```' } }) }).tool('lean_hover');
		const value = await item.execute({ path: '001.lean', line: 3, character: 2 });
		assert.match(value.text, /Demo\.two_add_two/);
	},
});

cases.push({
	name: '补全：只保留四个字段，最多 40 条',
	async fn() {
		const items = Array.from({ length: 45 }, (_, index) => ({
			label: `cand${index}`,
			kind: 3,
			detail: `detail ${index}`,
			insertText: `cand${index}`,
			extra: 'ignored',
		}));
		const { tool } = toolsOf({ completion: () => ({ ok: true, value: { isIncomplete: true, items } }) });
		const value = await tool('lean_completion').execute({ path: '001.lean', line: 4, character: 1 });
		assert.equal(value.items.length, 40);
		assert.equal(value.isIncomplete, true);
		assert.deepEqual(Object.keys(value.items[0]).sort(), ['detail', 'insertText', 'kind', 'label']);
	},
});

cases.push({
	name: '定义/引用：Location 转成 1 基的 path:line:character',
	async fn() {
		const locations = [
			{ path: '/proj/001.lean', uri: 'file:///proj/001.lean', range: { start: { line: 11, character: 4 }, end: { line: 11, character: 8 } } },
			{ path: '/proj/Lib.lean', uri: 'file:///proj/Lib.lean', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
		];
		const { tool } = toolsOf({
			definition: () => ({ ok: true, value: locations }),
			references: () => ({ ok: true, value: locations }),
		});
		const definition = await tool('lean_definition').execute({ path: '001.lean', line: 12, character: 5 });
		assert.deepEqual(definition.locations, [
			{ path: '/proj/001.lean', line: 12, character: 5 },
			{ path: '/proj/Lib.lean', line: 1, character: 1 },
		]);
		const rendered = tool('lean_definition').output.render({ line: 12, character: 5 }, definition)[0].text;
		assert.match(rendered, /定义（2 处）/);
		assert.match(rendered, /\/proj\/Lib\.lean:1:1/);
	},
});

cases.push({
	name: '代码动作：只留本文件的编辑，newText 原样带出',
	async fn() {
		const { tool } = toolsOf({
			codeActions: (body) => {
				assert.equal(body.range.start.line, 8);
				assert.equal(body.range.end.line, 9);
				return {
					ok: true,
					value: {
						actions: [
							{
								title: 'Try this: exact rfl',
								kind: 'quickfix',
								isPreferred: true,
								edit: {
									changes: [
										{ path: '/proj/001.lean', uri: 'file:///proj/001.lean', range: { start: { line: 8, character: 2 }, end: { line: 8, character: 6 } }, newText: 'exact rfl' },
										{ path: '/proj/Lib.lean', uri: 'file:///proj/Lib.lean', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'x' },
									],
								},
							},
						],
					},
				};
			},
		});
		const value = await tool('lean_code_actions').execute({ path: '001.lean', line: 9, character: 3 });
		assert.equal(value.actions.length, 1);
		assert.equal(value.actions[0].preferred, true);
		assert.equal(value.actions[0].edits.length, 1);
		assert.equal(value.actions[0].edits[0].line, 9);
		assert.equal(value.actions[0].edits[0].newText, 'exact rfl');
		const rendered = tool('lean_code_actions').output.render({ line: 9 }, value)[0].text;
		assert.match(rendered, /Try this: exact rfl \[quickfix\] ★/);
		assert.match(rendered, /9:3-9:7 → exact rfl/);
	},
});

cases.push({
	name: '代码动作：没有动作时给出说明而不是空串',
	async fn() {
		const { tool } = toolsOf({ codeActions: () => ({ ok: true, value: { actions: [] } }) });
		const value = await tool('lean_code_actions').execute({ path: '001.lean', line: 2, character: 1 });
		assert.equal(value.actions.length, 0);
		assert.match(tool('lean_code_actions').output.render({ line: 2 }, value)[0].text, /没有可用的代码动作/);
	},
});

cases.push({
	name: '大纲：SymbolKind 数字变成短标签，container 保留',
	async fn() {
		const { tool } = toolsOf({
			documentSymbol: () => ({
				ok: true,
				value: {
					symbols: [
						{ name: 'Demo', kind: 2, container: '', range: { start: { line: 9, character: 0 } }, selectionRange: { start: { line: 9, character: 0 } } },
						{ name: 'size', kind: 12, container: 'Demo', range: { start: { line: 20, character: 2 } }, selectionRange: { start: { line: 20, character: 6 } } },
					],
				},
			}),
		});
		const value = await tool('lean_outline').execute({ path: '001.lean' });
		assert.equal(value.symbols.length, 2);
		assert.equal(value.symbols[0].kind, 'module');
		assert.equal(value.symbols[1].kind, 'function');
		assert.equal(value.symbols[1].line, 21);
		assert.match(tool('lean_outline').output.render({}, value)[0].text, /Demo\.size/);
	},
});

cases.push({
	name: '搜索：没给 path 时用 anchor，limit 被夹到 1..100',
	async fn() {
		const limits = [];
		const { bridge, tool } = toolsOf({
			workspaceSymbol: (body) => {
				limits.push(body.limit);
				return {
					ok: true,
					value: { symbols: [{ name: 'double', kind: 14, container: '', path: '/proj/001.lean', range: { start: { line: 0, character: 4 } } }] },
				};
			},
		});
		const value = await tool('lean_search').execute({ query: 'double', limit: 999 });
		assert.equal(limits[0], 100);
		assert.equal(value.symbols.length, 1);
		assert.equal(value.symbols[0].kind, 'constant');
		assert.equal(value.symbols[0].line, 1);
		assert.ok(bridge.calls.some((call) => call.kind === 'anchor'));
		const prepared = bridge.calls.find((call) => call.kind === 'prepare');
		assert.equal(prepared.path, '/proj/001.lean');
	},
});

cases.push({
	name: '搜索：空 query 直接拒绝',
	async fn() {
		const { tool } = toolsOf({});
		for (const query of ['', '   ', undefined]) {
			const value = await tool('lean_search').execute({ query });
			assert.equal(value.status, 'error');
			assert.equal(value.code, 'invalid-args');
		}
	},
});

cases.push({
	name: '诊断需要等待（prepare wait:true），悬停不需要',
	async fn() {
		const { bridge, tool } = toolsOf({
			diagnostics: () => ({ ok: true, value: DIAGNOSTICS_VALUE }),
			hover: () => ({ ok: true, value: { text: 'x' } }),
		});
		await tool('lean_diagnostics').execute({ path: '001.lean', waitMs: 1234 });
		await tool('lean_hover').execute({ path: '001.lean', line: 1, character: 1 });
		const prepares = bridge.calls.filter((call) => call.kind === 'prepare');
		assert.equal(prepares[0].options.wait, true);
		assert.equal(prepares[0].options.timeoutMs, 1234);
		assert.equal(prepares[1].options.wait, false);
	},
});

cases.push({
	name: '构建产物 lib/index.js 里真的带上了注册管线',
	fn() {
		const code = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
		for (const name of LEAN_TOOL_NAMES) assert.ok(code.includes(`name: '${name}'`), name);
		assert.ok(code.includes("ctx.inject(['tools']"), '缺少 ctx.inject 调用');
		assert.ok(code.includes('waitForIdle'), '缺少 waitForIdle');
		assert.ok(code.includes('registerAgentTools'), '缺少 registerAgentTools');
		/* 宿主半不能有任何非 node: 的 import（link: 包解析不到别人的依赖树）。 */
		for (const line of code.split(/\r?\n/)) {
			const match = /^import\s.*from\s+['"]([^'"]+)['"]/.exec(line);
			if (match !== null) assert.ok(match[1].startsWith('node:'), '非法 import：' + match[1]);
		}
	},
});

let failed = 0;
for (const item of cases) {
	try {
		await item.fn();
		console.log(`  ok  ${item.name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${item.name}`);
		console.log(`       ${error.message}`);
	}
}
console.log(`host-tools: ${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;
