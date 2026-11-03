// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 浏览器侧 LSP 胶水的单测：URI 编码、位置换算、诊断映射、请求/事件管道。
//
// 只 import 纯函数模块（不碰 CodeMirror、不碰 DOM），所以不需要打包也不需要
// 浏览器环境；`fetch` 与 `EventSource` 全部注入。

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'src');

const { fileUriOf, createLspClient } = await import(pathToFileURL(resolve(src, 'lean-lsp.js')).href);
const { positionAt, offsetOf, toCmDiagnostics, keepSevereMarkers } = await import(pathToFileURL(resolve(src, 'lsp-extensions.js')).href);

let passed = 0;
const failures = [];

function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) passed += 1;
	else failures.push(`${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
}

/** 造一个 CodeMirror Text 的最小替身（只实现用到的成员）。 */
function makeDoc(text) {
	const lines = text.split('\n');
	const starts = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	return {
		lines: lines.length,
		length: text.length,
		line(number) {
			const index = Math.min(Math.max(1, number), lines.length) - 1;
			return {
				number: index + 1,
				from: starts[index],
				to: starts[index] + lines[index].length,
				text: lines[index],
			};
		},
		lineAt(position) {
			const clamped = Math.min(Math.max(0, position), text.length);
			let index = 0;
			for (let i = 0; i < lines.length; i += 1) {
				if (clamped >= starts[i]) index = i;
			}
			return this.line(index + 1);
		},
	};
}

/* ---- fileUriOf ---- */
check('盘符 + 空格', fileUriOf('D:\\deep dir\\a b.lean'), 'file:///D:/deep%20dir/a%20b.lean');
check('POSIX 路径', fileUriOf('/home/me/x.lean'), 'file:///home/me/x.lean');
check('反斜杠统一成正斜杠', fileUriOf('C:\\proj\\x.lean'), 'file:///C:/proj/x.lean');
check('非 ASCII 被百分号编码', fileUriOf('D:\\项目\\x.lean'), `file:///D:/${encodeURIComponent('项目')}/x.lean`);

/* ---- 位置换算 ---- */
const doc = makeDoc('def a := 1\n\ntheorem b : 2 = 2 := rfl\n');
check('positionAt 首行', positionAt(doc, 4), { line: 0, character: 4 });
check('positionAt 第三行', positionAt(doc, doc.line(3).from + 8), { line: 2, character: 8 });
check('positionAt 越界被裁剪', positionAt(doc, 9999), { line: 3, character: 0 });
check('offsetOf 回到原点', offsetOf(doc, 2, 8), doc.line(3).from + 8);
check('offsetOf 行列越界被裁剪', offsetOf(doc, 99, 99), doc.line(4).to);
check('offsetOf 负值当 0', offsetOf(doc, -1, -5), 0);
check('往返一致', positionAt(doc, offsetOf(doc, 2, 3)), { line: 2, character: 3 });

/* ---- 诊断映射 ---- */
const diagnostics = toCmDiagnostics(doc, [
	{ severity: 1, message: '未知标识符', startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 5, source: 'lean' },
	{ severity: 2, message: '未使用变量', startLine: 2, startCharacter: 8, endLine: 2, endCharacter: 9 },
	{ severity: 3, message: '提示', startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 0 },
	{ severity: 4, message: '灰线', startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
	{ message: '没有 severity', startLine: 0, startCharacter: 1, endLine: 0, endCharacter: 2 },
]);
check('诊断条数', diagnostics.length, 5);
check('severity 1 → error', diagnostics[0].severity, 'error');
check('severity 2 → warning', diagnostics[1].severity, 'warning');
check('severity 3 → info', diagnostics[2].severity, 'info');
check('severity 4 → hint', diagnostics[3].severity, 'hint');
check('缺 severity → error', diagnostics[4].severity, 'error');
check('source 缺省为 lean', diagnostics[1].source, 'lean');
check('零宽诊断补一个字符', diagnostics[2].to - diagnostics[2].from, 1);
check('端点反了会交换', toCmDiagnostics(doc, [{ message: 'x', startLine: 0, startCharacter: 9, endLine: 0, endCharacter: 3 }])[0].from <
	toCmDiagnostics(doc, [{ message: 'x', startLine: 0, startCharacter: 9, endLine: 0, endCharacter: 3 }])[0].to, true);
check('非数组输入不炸', toCmDiagnostics(doc, null), []);
check('脏条目被跳过', toCmDiagnostics(doc, [null, 5, { message: 'ok', startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 }]).length, 1);

/* ---- 客户端管道 ---- */
const calls = [];
function makeFetch(answer) {
	return async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, body });
		return {
			status: 200,
			async json() {
				return answer(body);
			},
		};
	};
}

const base = 'http://127.0.0.1:61253/?token=abc';
const client = createLspClient({ baseUrl: base, path: 'D:\\x\\001.lean', fetchImpl: makeFetch((body) => ({ ok: true, value: { echo: body.op } })) });
check('URI 由路径推出', client.uri, 'file:///D:/x/001.lean');
const value = await client.hover({ line: 1, character: 2 });
check('请求命中 /lean-lsp/api', calls[0].url, 'http://127.0.0.1:61253/lean-lsp/api');
check('op 与位置随请求发出', [calls[0].body.op, calls[0].body.line, calls[0].body.character], ['hover', 1, 2]);
check('响应取 value', value, { echo: 'hover' });

const failing = createLspClient({
	baseUrl: 'http://127.0.0.1:61253/',
	path: '/tmp/a.lean',
	fetchImpl: makeFetch(() => ({ ok: false, error: { code: 'lsp-timeout', message: 'lean 没有响应' } })),
});
let thrown = null;
try {
	await failing.hover({ line: 0, character: 0 });
} catch (error) {
	thrown = error.message;
}
check('错误信封抛异常并保留消息', thrown, 'lean 没有响应');

/* 轮询去重：同一份远端状态只广播一次。 */
const events = [];
const pulls = [];
const dedupe = createLspClient({
	baseUrl: 'http://127.0.0.1:61253/',
	path: '/tmp/b.lean',
	fetchImpl: makeFetch((body) => {
		pulls.push(body.op);
		return { ok: true, value: { state: 'ready', diagnostics: [{ message: 'w', severity: 2 }], progress: [] } };
	}),
	EventSourceImpl: undefined,
});
dedupe.onEvent((event) => events.push(event));
await dedupe.pull();
await dedupe.pull();
const diagnosticEvents = events.filter((event) => event.type === 'diagnostics');
check('相同状态只广播一次', diagnosticEvents.length, 1);
check('状态一起广播', events.filter((event) => event.type === 'status').length, 1);
dedupe.dispose();

/* 行号栏只给 error/warning 画标记：info 是 CodeMirror 的描边方块，会盖住证明完成的对勾。 */
check(
	'lintGutter 过滤掉 info/hint 方块',
	keepSevereMarkers([
		{ severity: 'error', from: 1 },
		{ severity: 'info', from: 2 },
		{ severity: 'warning', from: 3 },
		{ severity: 'hint', from: 4 },
		null,
		undefined
	]).map((item) => item.from),
	[1, 3]
);
check('lintGutter 过滤遇到非数组不抛', keepSevereMarkers(undefined), []);
check('lintGutter 过滤全部保留 error', keepSevereMarkers([{ severity: 'error', from: 7 }]).length, 1);

/*
 * 回归：「目标已完成」的诊断带 `isSilent: true`，会被 `toCmDiagnostics` 剔掉
 * （这是对的，否则 info 方块会占满行号栏）。但行号栏的对勾必须从**原始**列表取，
 * 否则 `leanTags: [2]` 一条都到不了 `accomplishedLines`，表现就是「有方块、没对勾」。
 */
const silentTagged = [
	{ severity: 3, startLine: 1, leanTags: [2], isSilent: true },
	{ severity: 3, startLine: 4, leanTags: [2], isSilent: true },
];
check('silent 的已完成诊断被 toCmDiagnostics 剔掉', toCmDiagnostics(makeDoc('a\nb\nc\nd\ne\n'), silentTagged), []);

/*
 * 回归：JSON-RPC 的数字错误码必须原样落到 `error.code` 上。
 *
 * infoview 判的是 `ex?.code === -32900`（RpcErrorCode.RpcNeedsReconnect），命中才会丢掉旧
 * RPC 会话重连；被降级成字符串种类名时它只当普通错误，面板上就留下永远消不掉的
 * 「Outdated RPC session. Try again.」。所以宿主半带回 `rpcCode` 时要保住数字。
 */
const rpcFailure = createLspClient({
	baseUrl: 'http://127.0.0.1:61253/',
	path: '/tmp/rpc.lean',
	fetchImpl: makeFetch(() => ({
		ok: false,
		error: { code: 'lsp-failed', rpcCode: -32900, message: 'Outdated RPC session' },
	})),
});
let rpcError = null;
try {
	await rpcFailure.request('$/lean/rpc/call', {});
} catch (error) {
	rpcError = error;
}
check('rpcCode 落到 error.code 上（infoview 靠它判断重连）', rpcError?.code, -32900);
check('种类名退到 error.kind，不丢', rpcError?.kind, 'lsp-failed');
check('错误消息保留', rpcError?.message, 'Outdated RPC session');

const plainFailure = createLspClient({
	baseUrl: 'http://127.0.0.1:61253/',
	path: '/tmp/plain.lean',
	fetchImpl: makeFetch(() => ({ ok: false, error: { code: 'lsp-timeout', message: '慢' } })),
});
let plainError = null;
try {
	await plainFailure.request('x', {});
} catch (error) {
	plainError = error;
}
check('没有 rpcCode 时 code 退回种类名', plainError?.code, 'lsp-timeout');

console.log(`lsp: ${passed}/${passed + failures.length} 通过`);
if (failures.length > 0) {
	console.log(failures.join('\n'));
	process.exit(1);
}
