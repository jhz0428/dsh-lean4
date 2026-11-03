// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 用「假 ctx + 真 lean --server」跑一遍已构建的宿主半（lib/index.js）。
//
// 目的：在动用户 profile 之前，证明 ① 路由确实注册上了、② op 分发与信封形状对、
// ③ 真的能从 lean 拿到目标与诊断。HTTP 层只用一个最小的 req/res 壳子模拟。
//
// 运行需要 danger-full-access（要 spawn `lean --server`）。

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');
/* 仓库根 = projects/fileviewer-highlight，001.lean 在 plugin-engineering 根下。 */
const file = resolve(repoRoot, '..', '..', '001.lean');

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

/** 最小请求壳子。 */
function makeRequest(payload) {
	const request = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
	request.method = 'POST';
	request.url = '/lean-lsp/api';
	request.headers = { 'content-type': 'application/json' };
	return request;
}

/** 最小响应壳子。 */
function makeResponse() {
	const chunks = [];
	const response = {
		statusCode: 200,
		headers: {},
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value;
		},
		writeHead(status, headers) {
			this.statusCode = status;
			Object.assign(this.headers, headers ?? {});
			return this;
		},
		write(chunk) {
			if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
			return true;
		},
		end(chunk) {
			if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
			this.finished = true;
		},
		get text() {
			return Buffer.concat(chunks).toString('utf8');
		},
	};
	return response;
}

const routes = [];
const fakeCtx = {
	webServer: {
		register(route) {
			routes.push(route);
			return () => {};
		},
		registerUpgrade() {
			return () => {};
		},
	},
	connection: { requestRejection: () => undefined },
	effect(fn) {
		return typeof fn === 'function' ? fn() : undefined;
	},
	logger: () => {},
	logger2: () => {},
};

const host = await import(pathToFileURL(resolve(packageRoot, 'lib', 'index.js')).href);
check('宿主半导出 apply/name/inject', typeof host.apply === 'function' && typeof host.name === 'string' && Array.isArray(host.inject), `${host.name} ${JSON.stringify(host.inject)}`);

host.apply(fakeCtx, {});

const api = routes.find((route) => String(route.path).includes('/lean-lsp/api'));
const events = routes.find((route) => String(route.path).includes('/lean-lsp/events'));
check('注册了 /lean-lsp/api 路由', api !== undefined, api === undefined ? `实际：${routes.map((r) => r.path).join(', ')}` : `kind=${api.kind} path=${api.path}`);
check('注册了 /lean-lsp/events 路由', events !== undefined, events === undefined ? '缺失' : `kind=${events.kind}`);

async function callApi(payload) {
	const response = makeResponse();
	await api.handler(makeRequest(payload), response);
	const text = response.text;
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text };
	}
	return { status: response.statusCode, body };
}

const source = readFileSync(file, 'utf8');
const opened = await callApi({ op: 'open', path: file, text: source });
check('open 返回 ok', opened.body?.ok === true, `status=${opened.status} ${JSON.stringify(opened.body).slice(0, 160)}`);

const goalLine = source.split('\n').findIndex((line) => line.includes('by omega'));
const goalText = source.split('\n')[goalLine] ?? '';
/* 光标要落在「还没被 tactic 解决」的位置：`by` 关键字处。跑到 omega 之后会返回 no goals。 */
const goalCharacter = Math.max(0, goalText.indexOf('by omega'));
const pulled = await callApi({ op: 'pull', path: file });
check('pull 返回服务器状态', pulled.body?.ok === true && typeof pulled.body?.value?.state === 'string', `state=${pulled.body?.value?.state} root=${pulled.body?.value?.root}`);
console.log('诊断样本：');
for (const item of (pulled.body?.value?.diagnostics ?? []).slice(0, 6)) {
	console.log(`   [sev ${item.severity}] ${String(item.message).split('\n')[0].slice(0, 100)}`);
}

/* 等诊断与目标：lean 冷启可能要几十秒，用 pull 轮询。 */
const deadline = Date.now() + 240_000;
let goal = null;
let diagnostics = [];
while (Date.now() < deadline) {
	const polled = await callApi({ op: 'pull', path: file });
	diagnostics = polled.body?.value?.diagnostics ?? [];
	const state = polled.body?.value?.state;
	if (state === 'ready') {
		const answer = await callApi({ op: 'goal', path: file, line: goalLine, character: goalCharacter });
		if (goal === null) {
			console.log(`   goal 首次响应：${JSON.stringify(answer.body).slice(0, 200)}`);
		}
		if (answer.body?.ok === true && answer.body.value !== null) {
			goal = answer.body.value;
			break;
		}
	}
	await new Promise((done) => setTimeout(done, 1500));
}

check('pull 里带回了诊断数组', Array.isArray(diagnostics), `${diagnostics.length} 条`);
check('goal 在 `by omega` 行返回目标', goal !== null && Array.isArray(goal.goals) && goal.goals.length > 0, goal === null ? '超时' : String(goal.goals[0] ?? '').slice(0, 120));

const hoverLine = source.split('\n').findIndex((line) => line.includes('theorem two_add_two'));
const hovered = await callApi({ op: 'hover', path: file, line: hoverLine, character: 10 });
check('hover 返回 markdown', hovered.body?.ok === true && typeof hovered.body?.value?.text === 'string', String(hovered.body?.value?.text ?? '').slice(0, 80).replace(/\n/g, ' '));

const bad = await callApi({ op: 'nope', path: file });
check('未知 op 返回结构化错误', bad.body?.ok === false && bad.body?.error?.code === 'bad-request', JSON.stringify(bad.body?.error));

await callApi({ op: 'stop', path: file });

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
