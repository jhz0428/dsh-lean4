// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// infoview 桥的单测：把官方 React 应用当成一个「要 EditorApi」的黑盒，
// 断言我们给它的每一个方法都按 infoview 的协议落到 editor / client 上。
// 这里不需要 DOM：renderInfoview 用假实现，只返回事件口。

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'src');

const { mountInfoview, insertInfoviewStyle, KEEP_ALIVE_MS } = await import(
	pathToFileURL(resolve(src, 'infoview.js')).href
);

let passed = 0;
const failures = [];

function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) passed += 1;
	else failures.push(`${name} 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
}

function checkTrue(name, value) {
	check(name, Boolean(value), true);
}

function makeClient(replies = {}) {
	const calls = [];
	return {
		calls,
		async request(method, params) {
			calls.push(['request', method, params]);
			return replies[method];
		},
		notify(method, params) {
			calls.push(['notify', method, params]);
		},
		async restart() {
			calls.push(['restart']);
		}
	};
}

function makeEditor() {
	const seen = { insertText: [], applyChanges: [], revealPosition: [] };
	return {
		seen,
		getText: () => 'theorem x : True := trivial',
		getCursor: () => ({ line: 0, character: 0 }),
		insertText(text, kind, pos) {
			seen.insertText.push([text, kind, pos]);
		},
		applyChanges(changes) {
			seen.applyChanges.push(changes);
		},
		revealPosition(position) {
			seen.revealPosition.push(position);
		}
	};
}

function makeModule() {
	const captured = { api: null, element: null, events: [] };
	const module = {
		renderInfoview(api, element) {
			captured.api = api;
			captured.element = element;
			return {
				serverRestarted: (payload) => captured.events.push(['serverRestarted', payload]),
				serverStopped: (payload) => captured.events.push(['serverStopped', payload]),
				changedCursorLocation: (payload) => captured.events.push(['cursor', payload]),
				gotServerNotification: (method, params) => captured.events.push(['notification', method, params]),
				sentClientNotification: (method, params) => captured.events.push(['sent', method, params])
			};
		}
	};
	return { module, captured };
}

const ELEMENT = { replaceChildren() { this.cleared = true; } };
const URI = 'file:///D:/work/001.lean';

// 1) renderInfoview 必须是函数
{
	let message = '';
	try {
		mountInfoview({ module: {}, element: ELEMENT, client: makeClient(), uri: URI, editor: makeEditor() });
	} catch (error) {
		message = error.message;
	}
	check('缺少 renderInfoview 时抛错', message.includes('renderInfoview'), true);
}

// 2) 启动时把 EditorApi 交给 infoview
{
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client: makeClient(), uri: URI, editor: makeEditor() });
	check('renderInfoview 收到挂载点', captured.element === ELEMENT, true);
	check('EditorApi 与上游一样是 14 个方法', Object.keys(captured.api).length, 14);
	checkTrue('EditorApi 有 createRpcSession', typeof captured.api.createRpcSession === 'function');
	bridge.dispose();
}

// 3) sendClientRequest 原样转发给 client.request
{
	const client = makeClient({ 'custom/query': { ok: 1 } });
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client, uri: URI, editor: makeEditor() });
	const result = await captured.api.sendClientRequest(URI, 'custom/query', { a: 1 });
	check('请求转发到 client.request', client.calls, [['request', 'custom/query', { a: 1 }]]);
	check('请求结果原样返回', result, { ok: 1 });
	bridge.dispose();
}

// 4) 订阅过的客户端通知会回放给 infoview
{
	const client = makeClient();
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client, uri: URI, editor: makeEditor() });
	await captured.api.subscribeClientNotifications('$/lean/rpc/call');
	await captured.api.sendClientNotification(URI, '$/lean/rpc/call', { x: 1 });
	check('通知既发给宿主也回放给 infoview', client.calls[0], ['notify', '$/lean/rpc/call', { x: 1 }]);
	check('回放事件带方法名', captured.events.at(-1), ['sent', '$/lean/rpc/call', { x: 1 }]);
	await captured.api.unsubscribeClientNotifications('$/lean/rpc/call');
	await captured.api.sendClientNotification(URI, '$/lean/rpc/call', { x: 2 });
	check('退订后不再回放', captured.events.filter((event) => event[0] === 'sent').length, 1);
	bridge.dispose();
}

// 5) 服务器通知只转给订阅者
{
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client: makeClient(), uri: URI, editor: makeEditor() });
	bridge.notification('$/lean/fileProgress', { text: 'x' });
	check('未订阅的通知被丢弃', captured.events.length, 0);
	await captured.api.subscribeServerNotifications('$/lean/fileProgress');
	bridge.notification('$/lean/fileProgress', { text: 'x' });
	check('订阅后转发', captured.events.at(-1), ['notification', '$/lean/fileProgress', { text: 'x' }]);
	bridge.dispose();
}

// 6) createRpcSession 发 connect 并开始 keepAlive；closeRpcSession 发 release
{
	const client = makeClient({ '$/lean/rpc/connect': { sessionId: 's-1' } });
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client, uri: URI, editor: makeEditor() });
	const sessionId = await captured.api.createRpcSession();
	check('connect 拿到 sessionId', sessionId, 's-1');
	check('connect 带 uri', client.calls[0], ['request', '$/lean/rpc/connect', { uri: URI }]);
	check('keepAlive 间隔留足余量', KEEP_ALIVE_MS >= 10_000, true);
	/*
	 * 服务器 30 s 没收到 keepAlive 就回收会话（Lean 的 `RpcSession.keepAliveTimeMs`）。
	 * 间隔必须能容下至少两次丢失：30 / 10 = 3 次机会。15 s 那种「两次机会」的写法
	 * 在页面切后台节流、宿主半重启时很容易掉线。
	 */
	check('keepAlive 间隔容得下 3 次机会（30 s 窗口）', 30_000 / KEEP_ALIVE_MS >= 3, true);
	await captured.api.closeRpcSession('s-1');
	check('release 带 sessionId', client.calls.at(-1), [
		'notify',
		'$/lean/rpc/release',
		{ uri: URI, sessionId: 's-1', refs: [] }
	]);
	bridge.dispose();
}

// 7) connect 没给 sessionId 要明确报错
{
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client: makeClient({}), uri: URI, editor: makeEditor() });
	let message = '';
	try {
		await captured.api.createRpcSession();
	} catch (error) {
		message = error.message;
	}
	check('缺 sessionId 时报错', message.includes('sessionId'), true);
	bridge.dispose();
}

// 8) insertText / applyEdit / showDocument 落到 editor 上
{
	const editor = makeEditor();
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client: makeClient(), uri: URI, editor });
	await captured.api.insertText('have : True := trivial', 'above', { line: 0, character: 0 });
	check('insertText 转发文本', editor.seen.insertText[0][0], 'have : True := trivial');
	check('insertText 保留 kind', editor.seen.insertText[0][1], 'above');
	await captured.api.applyEdit({ changes: { [URI]: [{ newText: 'x' }], 'file:///other.lean': [] } });
	check('applyEdit 只取本文档的改动', editor.seen.applyChanges, [[{ newText: 'x' }]]);
	await captured.api.applyEdit({ changes: { 'file:///other.lean': [{ newText: 'y' }] } });
	check('别人的改动不落地', editor.seen.applyChanges.length, 1);
	await captured.api.showDocument({ uri: URI, selection: { start: { line: 3, character: 1 } } });
	check('showDocument 跳到指定位置', editor.seen.revealPosition, [{ line: 3, character: 1 }]);
	await captured.api.showDocument({ uri: 'file:///other.lean', selection: { start: { line: 9, character: 0 } } });
	check('别的文件不跳', editor.seen.revealPosition.length, 1);
	bridge.dispose();
}

// 9) restartFile 走 client.restart
{
	const client = makeClient();
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client, uri: URI, editor: makeEditor() });
	await captured.api.restartFile();
	check('restartFile 触发重启', client.calls, [['restart']]);
	bridge.dispose();
}

// 10) 出站事件：serverRestarted / serverStopped / 光标
{
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client: makeClient(), uri: URI, editor: makeEditor() });
	bridge.serverReady({ hoverProvider: true }, { name: 'Lean 4 Server', version: '0.3.0' });
	check('serverReady 填 capabilities', captured.events.at(-1), [
		'serverRestarted',
		{ capabilities: { hoverProvider: true }, serverInfo: { name: 'Lean 4 Server', version: '0.3.0' } }
	]);
	bridge.serverStopped('failed', 'boom');
	check('serverStopped 转发原因', captured.events.at(-1), ['serverStopped', { reason: 'failed', message: 'boom' }]);
	bridge.cursor({ line: 2, character: 4 });
	check('光标事件带 uri 与零宽 range', captured.events.at(-1), [
		'cursor',
		{ uri: URI, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } } }
	]);
	bridge.dispose();
}

// 10b) 版本号解析不了不能喂给 infoview：它会在自己的 React 树里抛错，整块面板白掉
{
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client: makeClient(), uri: URI, editor: makeEditor() });
	const before = captured.events.length;
	bridge.serverReady({}, {});
	bridge.serverReady({}, undefined);
	bridge.serverReady(undefined, { name: 'Lean 4 Server' });
	bridge.serverReady(undefined, { version: '' });
	bridge.serverReady(undefined, { version: 'lean4' });
	check('版本号不可用时一次都不发 serverRestarted', captured.events.length, before);
	bridge.serverReady(undefined, { version: '4.35.0' });
	check('版本号可用时照常转发', captured.events.at(-1)[0], 'serverRestarted');
	bridge.serverReady(undefined, { version: '4.9' });
	check('两段版本号也接受（infoview 的 ofString 允许）', captured.events.at(-1)[0], 'serverRestarted');
	bridge.dispose();
}

// 11) dispose 之后不再推送、并清空挂载点
{
	const element = { replaceChildren() { this.cleared = true; } };
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element, client: makeClient(), uri: URI, editor: makeEditor() });
	bridge.dispose();
	const before = captured.events.length;
	bridge.serverReady({}, {});
	bridge.cursor({ line: 0, character: 0 });
	bridge.notification('$/lean/fileProgress', {});
	check('dispose 后不再产生事件', captured.events.length, before);
	check('dispose 清空挂载点', element.cleared, true);
}

// 12) 样式只注入一次，且空 CSS 不注入
{
	const head = {
		children: [],
		appendChild(node) {
			this.children.push(node);
		}
	};
	const doc = {
		head,
		createElement: () => ({}),
		getElementById(id) {
			return head.children.find((node) => node.id === id) ?? null;
		}
	};
	insertInfoviewStyle(doc, '');
	check('空 CSS 不注入', head.children.length, 0);
	insertInfoviewStyle(doc, '.x{color:red}');
	insertInfoviewStyle(doc, '.x{color:red}');
	check('样式只注入一次', head.children.length, 1);
	check('样式内容落地', head.children[0].textContent, '.x{color:red}');
}

// 13) copyToClipboard 在没有 clipboard 的环境里不抛
{
	const { module, captured } = makeModule();
	const bridge = mountInfoview({ module, element: ELEMENT, client: makeClient(), uri: URI, editor: makeEditor() });
	let threw = false;
	try {
		await captured.api.copyToClipboard('x');
	} catch {
		threw = true;
	}
	check('没有 clipboard 也不抛', threw, false);
	bridge.dispose();
}

console.log(`infoview: ${passed}/${passed + failures.length} 通过`);
if (failures.length > 0) {
	for (const failure of failures) console.error(`  x ${failure}`);
	process.exitCode = 1;
}
