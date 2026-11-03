// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 保存路径的契约测试。
//
// 这里钉住三件事：路由怎么拼（前导斜杠是 404 的经典来源）、查询参数怎么带、以及
// 响应信封怎么翻译成三种结果（保存成功 / 冲突 / 失败）——409 是冲突而非错误，这条
// 区分决定了界面给不给「仍然保存」。

import { resolveRoute, writeUrl, readWriteEnvelope } from '../src/save.js';

let passed = 0;
const failures = [];

function check(name, run) {
	try {
		run();
		passed += 1;
	} catch (error) {
		failures.push(`${name}: ${error.message}`);
	}
}

function assertEqual(actual, expected, message) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${message}\n  实际: ${a}\n  期望: ${b}`);
}

function withDocument(baseURI, run) {
	const had = 'document' in globalThis;
	const previous = globalThis.document;
	globalThis.document = { baseURI };
	try {
		run();
	} finally {
		if (had) globalThis.document = previous;
		else delete globalThis.document;
	}
}

check('有 hostRouteUrl 时用它（保留反代前缀）', () => {
	const service = { hostRouteUrl: (path) => `/dataops/proxy/3080/${path}` };
	assertEqual(resolveRoute(service, 'sidebar/write'), '/dataops/proxy/3080/sidebar/write', '路由');
});

check('没有 hostRouteUrl 时回落到 document.baseURI', () => {
	withDocument('https://host/dataops/proxy/3080/', () => {
		assertEqual(resolveRoute({}, 'sidebar/write'), 'https://host/dataops/proxy/3080/sidebar/write', '回落路由');
	});
});

check('连 document 都没有时给出绝对 URL，而不是抛错', () => {
	const had = 'document' in globalThis;
	const previous = globalThis.document;
	delete globalThis.document;
	try {
		assertEqual(resolveRoute(undefined, 'sidebar/write'), 'http://localhost/sidebar/write', '兜底');
	} finally {
		if (had) globalThis.document = previous;
	}
});

check('writeUrl 带 sessionId 与 path', () => {
	const url = new URL(writeUrl('http://localhost/sidebar/write', { sessionId: 's-1', path: '/w/001.lean' }));
	assertEqual(url.pathname, '/sidebar/write', 'path');
	assertEqual(url.searchParams.get('sessionId'), 's-1', 'sessionId');
	assertEqual(url.searchParams.get('path'), '/w/001.lean', '文件路径');
	assertEqual(url.searchParams.has('expectedMtimeMs'), false, '没有基线就不要带这个参数');
});

check('writeUrl 带 mtime 基线时作为门禁参数', () => {
	const url = new URL(writeUrl('http://localhost/sidebar/write', { sessionId: 's-1', path: 'a.lean', expectedMtimeMs: 1700000000000 }));
	assertEqual(url.searchParams.get('expectedMtimeMs'), '1700000000000', '基线');
});

check('非法基线被忽略，而不是写成 NaN', () => {
	const url = new URL(writeUrl('http://localhost/sidebar/write', { sessionId: 's', path: 'a.lean', expectedMtimeMs: Number.NaN }));
	assertEqual(url.searchParams.has('expectedMtimeMs'), false, 'NaN 不应出现');
});

check('路径里的空格与中文被正确编码', () => {
	const url = new URL(writeUrl('http://localhost/sidebar/write', { sessionId: 's', path: '/w/空 间/001.lean' }));
	assertEqual(url.searchParams.get('path'), '/w/空 间/001.lean', '解码后应还原');
});

check('200 + ok → saved 并带 mtime', () => {
	assertEqual(
		readWriteEnvelope(200, { ok: true, value: { ok: true, mtimeMs: 123 } }),
		{ kind: 'saved', mtimeMs: 123 },
		'成功'
	);
});

check('200 + ok 但没有 mtime → saved 且 mtimeMs 为 undefined', () => {
	assertEqual(readWriteEnvelope(200, { ok: true, value: { ok: true } }), { kind: 'saved', mtimeMs: undefined }, '无 mtime');
});

check('409 → conflict，并取 wire 错误信息', () => {
	assertEqual(
		readWriteEnvelope(409, { ok: false, error: { code: 'fs-conflict', message: 'file changed on disk' } }),
		{ kind: 'conflict', message: 'file changed on disk' },
		'冲突'
	);
});

check('409 没有错误信息时给一句人话兜底', () => {
	assertEqual(readWriteEnvelope(409, null), { kind: 'conflict', message: '磁盘上的文件已变化' }, '兜底文案');
});

check('500 → failed，带 HTTP 状态', () => {
	assertEqual(readWriteEnvelope(500, null), { kind: 'failed', message: 'HTTP 500' }, '失败');
});

check('2xx 但信封 ok:false → failed', () => {
	assertEqual(
		readWriteEnvelope(200, { ok: false, error: { message: 'permission denied' } }),
		{ kind: 'failed', message: 'permission denied' },
		'信封失败'
	);
});

check('错误信息是字符串时也能用', () => {
	assertEqual(readWriteEnvelope(200, { ok: false, error: 'nope' }), { kind: 'failed', message: 'nope' }, '字符串错误');
});

check('信封形状不认识时不炸', () => {
	assertEqual(readWriteEnvelope(200, { value: null }), { kind: 'saved', mtimeMs: undefined }, '空 value');
	assertEqual(readWriteEnvelope(204, undefined), { kind: 'saved', mtimeMs: undefined }, '无 body');
});

if (failures.length > 0) {
	console.error(`save: ${passed} 通过 / ${failures.length} 失败`);
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	process.exit(1);
}
console.log(`save: ${passed}/${passed} 通过`);
