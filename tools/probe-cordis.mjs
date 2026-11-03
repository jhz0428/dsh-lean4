// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 在**真的 cordis** 里加载宿主半，确认 apply 能跑通。
//
// 为什么需要它：`probe-host-routes.mjs` 用的是手写假 ctx，绕过了 cordis 的
// Proxy 陷阱。而真 ctx 上有两条完全不同的规则：
//   * `ctx.someString = value` 会抛 `cannot set property "…" without provide`；
//   * `ctx[Symbol()] = value` 才会落到 `Reflect.set`。
// 之前的 405 事故就是「路由没注册上」，而假 ctx 永远发现不了这类问题。
//
// 用法：node tools/probe-cordis.mjs  （需要 danger-full-access：会 spawn lean）
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
/* tools → dsh-lean4 → packages → fileviewer-highlight → projects → plugin-engineering */
const workspaceRoot = resolve(here, '..', '..', '..', '..', '..');
const packageDir = resolve(here, '..');
const cordisDir = join(workspaceRoot, 'work', 'extracted', 'cordis');
const hostFile = join(packageDir, 'lib', 'index.js');
const sample = join(workspaceRoot, '001.lean');

const CORDIS_URL = pathToFileURL(join(cordisDir, 'index.js')).href;
const checks = [];

function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const { Context } = await import(CORDIS_URL);
const ctx = new Context();

/* 两个注入的服务：形状对得上就够了，我们关心的是注册与调用路径。
   cordis 要求先 provide 再赋值，否则会抛 `cannot set property "…" without provide`。 */
const routes = new Map();
ctx.provide('webServer');
ctx.set('webServer', {
	register(route) {
		if (routes.has(route.path)) throw new Error(`webserver: duplicate route "${route.path}"`);
		routes.set(route.path, route);
		return () => routes.delete(route.path);
	},
	registerUpgrade() {
		return () => {};
	},
});
ctx.provide('connection');
ctx.set('connection', { requestRejection: () => undefined });

/* 第三个服务是 `tools`：Agent 工具的落点。用真 dsh-tools 的校验器检查每个定义，
   否则「注册成功」只能证明形状像，不能证明它真的能被 ToolRuntime 接受。 */
const registered = new Map();
ctx.provide('tools');
ctx.set('tools', {
	register(definition) {
		if (registered.has(definition.name)) throw new Error(`tools: duplicate tool "${definition.name}"`);
		registered.set(definition.name, definition);
		return () => registered.delete(definition.name);
	},
});
const toolsPkgDir = join(workspaceRoot, 'work', 'extracted', 'dsh-tools');
const toolsPkg = await import(pathToFileURL(join(toolsPkgDir, 'lib', 'index.js')).href);

const plugin = await import(pathToFileURL(hostFile).href);
check('宿主半可 import', typeof plugin.apply === 'function', `inject=${JSON.stringify(plugin.inject)}`);

try {
	ctx.plugin(plugin);
	check('ctx.plugin() 未抛错', true);
} catch (error) {
	check('ctx.plugin() 未抛错', false, error instanceof Error ? error.message : String(error));
}

/* cordis 的 effect 要等 fiber 起来才跑，等一拍再看。 */
await new Promise((done) => setTimeout(done, 50));

/* cordis 的 effect 在同一个 tick 里同步执行，路由应当已经就位。 */
check('注册了 /lean-lsp/api', routes.has('/lean-lsp/api'), [...routes.keys()].join(', ') || '(空)');
check('注册了 /lean-lsp/events', routes.has('/lean-lsp/events'));

const api = routes.get('/lean-lsp/api');
if (api !== undefined) {
	const body = await new Promise((done) => {
		const req = {
			method: 'POST',
			url: '/lean-lsp/api',
			on() {},
			[Symbol.asyncIterator]() {
				let sent = false;
				return {
					async next() {
						if (sent) return { done: true, value: undefined };
						sent = true;
						return { done: false, value: Buffer.from(JSON.stringify({ op: 'pull', path: sample })) };
					},
				};
			},
		};
		const res = {
			status: 0,
			headers: {},
			writeHead(status, headers) {
				this.status = status;
				Object.assign(this.headers, headers ?? {});
				return this;
			},
			end(text) {
				done({ status: this.status, text: String(text ?? '') });
			},
			write() {},
		};
		Promise.resolve(api.handler(req, res)).catch((error) => {
			done({ status: 0, text: String(error) });
		});
	});
	let parsed = null;
	try {
		parsed = JSON.parse(body.text);
	} catch {
		parsed = null;
	}
	check('POST /lean-lsp/api 走了我的处理器', parsed !== null && typeof parsed === 'object', `status=${body.status} body=${body.text.slice(0, 120)}`);

/** 打一次 /lean-lsp/api，返回解析后的 JSON（解析不了返回 null）。 */
async function postApi(handler, payload) {
	return await new Promise((done) => {
		const req = {
			method: 'POST',
			url: '/lean-lsp/api',
			on() {},
			[Symbol.asyncIterator]() {
				let sent = false;
				return {
					async next() {
						if (sent) return { done: true, value: undefined };
						sent = true;
						return { done: false, value: Buffer.from(JSON.stringify(payload)) };
					},
				};
			},
		};
		const res = {
			status: 0,
			writeHead(status) {
				this.status = status;
				return this;
			},
			end(body) {
				try {
					done(JSON.parse(String(body ?? '')));
				} catch {
					done(null);
				}
			},
			write() {},
		};
		Promise.resolve(handler(req, res)).catch(() => done(null));
	});
}

/* 相对/不存在的路径必须被明确拒掉。
 * 2026-11-03 的事故：查看器给相对路径 → 拼出不存在的 cwd → spawn ENOENT → 无限重建。 */
if (api !== undefined) {
	const relative = await postApi(api.handler, { op: 'pull', path: '施工方案/PlanSpec.lean' });
	check(
		'相对/不存在的路径返回 unknown-file',
		relative !== null && relative.ok === false && relative.error?.code === 'unknown-file',
		JSON.stringify(relative).slice(0, 160),
	);
}
}

/* ── Agent 工具 ───────────────────────────────────────────────────────── */
check('注册了 9 个 Agent 工具', registered.size === 9, [...registered.keys()].join(', ') || '(空)');

let schemaOk = true;
let schemaDetail = '';
for (const [name, definition] of registered) {
	try {
		toolsPkg.assertSupportedJsonSchema(definition.output.schema);
	} catch (error) {
		schemaOk = false;
		schemaDetail = `${name}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
check('每个工具的 output.schema 都过 dsh-tools 的白名单', schemaOk, schemaDetail || '9/9');

/* 参数也要能被真校验器接受：`additionalProperties: false` + `required` 写错时
   模型侧才会炸，这里提前发现。 */
const SAMPLE_ARGS = {
	lean_diagnostics: { path: sample },
	lean_goal: { path: sample, line: 1, character: 1 },
	lean_hover: { path: sample, line: 1, character: 1 },
	lean_completion: { path: sample, line: 1, character: 1 },
	lean_definition: { path: sample, line: 1, character: 1 },
	lean_references: { path: sample, line: 1, character: 1 },
	lean_code_actions: { path: sample, line: 1, character: 1 },
	lean_outline: { path: sample },
	lean_search: { query: 'double' },
};
let argsOk = true;
let argsDetail = '';
for (const [name, definition] of registered) {
	const violations = toolsPkg.validateJsonSchemaValue(definition.parameters, SAMPLE_ARGS[name], '');
	if (violations.length > 0) {
		argsOk = false;
		argsDetail = `${name}: ${violations[0]}`;
	}
	/* 未知键必须被拒：这是 `additionalProperties: false` 的意义所在。 */
	const rejected = toolsPkg.validateJsonSchemaValue(definition.parameters, { ...SAMPLE_ARGS[name], bogusKey: 1 }, '');
	if (rejected.length === 0) {
		argsOk = false;
		argsDetail = `${name}: 未知参数没有被拒`;
	}
}
check('参数 schema 能校验示例入参', argsOk, argsDetail || '9/9');

const diagnosticsTool = registered.get('lean_diagnostics');
if (diagnosticsTool !== undefined) {
	let value = null;
	let failure = '';
	try {
		value = await diagnosticsTool.execute({ path: sample }, { signal: undefined });
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const detail =
		failure !== ''
			? failure
			: value === null
				? 'no value'
				: value.status === 'ok'
					? `state=${value.state} diagnostics=${value.diagnostics.length} settled=${value.settled}`
					: `${value.code}: ${value.message}`;
	check('lean_diagnostics 能在真进程里跑出结果', value !== null && value.status === 'ok' && Array.isArray(value.diagnostics), detail);
	if (value !== null && value.status === 'ok') {
		const rendered = diagnosticsTool.output.render({ path: sample }, value)[0].text;
		check('诊断渲染成可读文本', rendered.includes(sample) || rendered.includes('没有诊断'), rendered.slice(0, 160));
	}
	const outlineTool = registered.get('lean_outline');
	const outline = await outlineTool.execute({ path: sample }, { signal: undefined });
	check(
		'lean_outline 能列出声明',
		outline.status === 'ok' && outline.symbols.length > 5,
		outline.status === 'ok' ? `${outline.symbols.length} 个符号，首个 ${outline.symbols[0]?.name}` : outline.message,
	);
	const searchTool = registered.get('lean_search');
	const search = await searchTool.execute({ path: sample, query: 'double' }, { signal: undefined });
	check(
		'lean_search 能跨文件搜到符号',
		search.status === 'ok' && search.symbols.some((item) => item.name.includes('double')),
		search.status === 'ok' ? `${search.symbols.length} 个结果` : search.message,
	);
}

/* 重复 apply 必须被守护拦住，而不是注册第二份路由。 */
try {
	ctx.plugin(plugin);
	check('重复 apply 不会抛错', true);
} catch (error) {
	check('重复 apply 不会抛错', false, error instanceof Error ? error.message : String(error));
}

await ctx.lifecycle?.flush?.().catch?.(() => {});

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
