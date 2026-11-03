// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 保存路径的纯逻辑：URL 拼装与响应解读。
//
// 单独成文件是为了能在 Node 里直接测——不碰 fetch、不碰 DOM。
//
// 契约（docs/external-plugin-guide.md §6）：
//   POST /sidebar/write?sessionId=&cwd=&path=&expectedMtimeMs=
//   请求体就是 LF 文档；响应是 `{ ok: true, value: { ok: true, mtimeMs? } }` 信封；
//   `expectedMtimeMs` 是乐观并发门，磁盘 mtime 与基线不符则 409 / `fs-conflict`。

/**
 * 解析一条 better-sidebar 路由。
 *
 * v0.25.0+ 有 `hostRouteUrl()`，它用宿主同款的传输基底并保留反代前缀；老版本没有
 * 就退回 `document.baseURI`（拿不到桌面壳的真实基底，但总比钉死源站根强）。
 * 两种情况下都**不写前导斜杠**——写斜杠会把请求钉在源站根，反代挂在子路径时 404。
 */
export function resolveRoute(service, route) {
	if (service !== undefined && service !== null && typeof service.hostRouteUrl === 'function') {
		return service.hostRouteUrl(route);
	}
	const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://localhost/';
	return new URL(route, base).href;
}

/** 保存 URL。`cwd` 省略时宿主用会话权威 cwd 作相对路径基准。 */
export function writeUrl(baseUrl, { sessionId, path, expectedMtimeMs }) {
	const url = new URL(baseUrl, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/');
	url.searchParams.set('sessionId', sessionId);
	url.searchParams.set('path', path);
	if (typeof expectedMtimeMs === 'number' && Number.isFinite(expectedMtimeMs)) {
		url.searchParams.set('expectedMtimeMs', String(expectedMtimeMs));
	}
	return url.href;
}

/**
 * 把一个保存响应解读成三种结果之一。
 *
 * 409 是**冲突**而不是错误：它意味着磁盘上的 mtime 与基线不符（模型改过、或者文件
 * 被删除/改名——数字基线只可能来自一次成功的读取）。
 */
export function readWriteEnvelope(status, payload) {
	const envelope = payload !== null && typeof payload === 'object' ? payload : {};
	if (status === 409) {
		return { kind: 'conflict', message: errorMessage(envelope) ?? '磁盘上的文件已变化' };
	}
	if (status < 200 || status >= 300) {
		return { kind: 'failed', message: errorMessage(envelope) ?? `HTTP ${status}` };
	}
	if (envelope.ok === false) {
		return { kind: 'failed', message: errorMessage(envelope) ?? '保存被拒绝' };
	}
	const value = envelope.value !== null && typeof envelope.value === 'object' ? envelope.value : {};
	return { kind: 'saved', mtimeMs: typeof value.mtimeMs === 'number' ? value.mtimeMs : undefined };
}

/** 从信封里挖出人话错误信息；挖不到就返回 undefined，让调用方用自己的兜底文案。 */
function errorMessage(envelope) {
	const error = envelope.error;
	if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
		return error.message;
	}
	if (typeof error === 'string' && error !== '') return error;
	return undefined;
}
