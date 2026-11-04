// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 宿主半 Lean LSP 客户端的「管道断了怎么办」测试。
//
// 背景：DSH 宿主把任何未捕获异常都当致命错误（写 stderr 后 exit(1)）。Lean 子进程退出后
// 残留的一次 `write EPIPE` 如果没有 error 监听，就会变成 uncaughtException，把宿主连同
// 所有会话打死，桌面端只看到「应用无法启动或已意外停止」。这里断言三件事：
//   - stdin/stdout/stderr 都挂了 error 监听，异步 EPIPE 不会冒成未捕获异常；
//   - 断管后等待中的请求会被拒掉，而不是挂到超时；
//   - 断管后 send 立刻给出可读错误，dispose 仍然安全。
//
// 全部走注入的假 spawn，不启动真的 Lean。

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'src');
const { createLeanServer } = await import(pathToFileURL(resolve(src, 'host', 'lean-server.js')).href);

/**
 * 造一个假 Lean 子进程。
 *
 * @param {object} [options]
 * @param {boolean} [options.answerInitialize] 是否回 initialize 响应（true 时 start 能就绪）。
 * @param {boolean} [options.throwOnWrite] 写入是否同步抛 EPIPE（模拟刚销毁的管道）。
 */
function fakeChild(options = {}) {
	const answerInitialize = options.answerInitialize !== false;
	const child = new EventEmitter();
	child.written = [];
	child.killed = false;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new Writable({
		write(chunk, _encoding, callback) {
			const text = chunk.toString('utf8');
			child.written.push(text);
			if (options.throwOnWrite === true) {
				const error = new Error('EPIPE: broken pipe, write');
				error.code = 'EPIPE';
				callback(error);
				return;
			}
			callback();
			if (answerInitialize && text.includes('"initialize"')) {
				const id = /"id":(\d+)/.exec(text)?.[1];
				if (id !== undefined) {
					const body = JSON.stringify({ jsonrpc: '2.0', id: Number(id), result: { capabilities: {} } });
					child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
				}
			}
			if (text.includes('"shutdown"') || text.includes('"exit"')) child.emit('exit', 0, null);
		},
	});
	child.kill = () => {
		child.killed = true;
	};
	return child;
}

function makeServer(child) {
	return createLeanServer({
		spawn: () => child,
		cwd: 'D:/proj',
		log: () => {},
	});
}

/** 等一个 promise 落地，返回 `{ ok, error }`；超时算失败。 */
async function settle(promise, timeoutMs = 2_000) {
	let timer;
	const guard = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error('promise 没有在超时内落地')), timeoutMs);
	});
	try {
		const value = await Promise.race([promise, guard]);
		return { ok: true, value };
	} catch (error) {
		return { ok: false, error };
	} finally {
		clearTimeout(timer);
	}
}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
	try {
		assert.deepStrictEqual(actual, expected);
		passed += 1;
	} catch {
		failures.push(`${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}
function checkTrue(name, value, note = '') {
	try {
		assert.ok(value, note);
		passed += 1;
	} catch {
		failures.push(`${name}${note === '' ? '' : `\n  ${note}`}`);
	}
}

/* ---- 1. 三个流都挂了 error 监听 ---- */
{
	const child = fakeChild();
	const server = makeServer(child);
	await server.start();
	check('stdin 有 error 监听', child.stdin.listenerCount('error') > 0, true);
	check('stdout 有 error 监听', child.stdout.listenerCount('error') > 0, true);
	check('stderr 有 error 监听', child.stderr.listenerCount('error') > 0, true);
	server.dispose('test');
}

/* ---- 2. 异步 EPIPE 不成为未捕获异常，等待中的请求被拒掉 ---- */
{
	const child = fakeChild({ answerInitialize: false });
	const server = makeServer(child);
	const starting = server.start();
	starting.catch(() => {});

	// 让 start() 把 initialize 写出去并挂进 pending，再从流上抛出 EPIPE。
	await new Promise((resolveTick) => setTimeout(resolveTick, 20));
	checkTrue('initialize 已经发出', child.written.some((text) => text.includes('"initialize"')));

	const emitted = child.stdin.emit('error', Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }));
	check('emit error 有监听接住（返回 true）', emitted, true);

	const outcome = await settle(starting);
	check('等待中的 initialize 被拒绝', outcome.ok, false);
	checkTrue(
		'拒绝原因指向写管道',
		String(outcome.error?.message ?? '').includes('could not write to the Lean server'),
		String(outcome.error?.message ?? ''),
	);
	check('状态变 failed', server.state, 'failed');
	checkTrue(
		'stderr 快照留下证据',
		server.snapshot().stderr.some((line) => line.includes('stdin error')),
		JSON.stringify(server.snapshot().stderr),
	);
	server.dispose('test');
}

/* ---- 3. 断管之后 send 立刻失败，不挂到 30s 超时 ---- */
{
	const child = fakeChild({ answerInitialize: false });
	const server = makeServer(child);
	const starting = server.start();
	starting.catch(() => {});
	await new Promise((resolveTick) => setTimeout(resolveTick, 20));
	child.stdin.emit('error', Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }));
	await settle(starting);

	const outcome = await settle(server.request('textDocument/hover', {}));
	check('后续请求被拒绝', outcome.ok, false);
	checkTrue(
		'错误里带上了断管原因',
		String(outcome.error?.message ?? '').includes('EPIPE'),
		String(outcome.error?.message ?? ''),
	);
	server.dispose('test');
}

/* ---- 4. write 同步抛错也不外泄，dispose 仍然安全 ---- */
{
	const child = fakeChild({ answerInitialize: false });
	child.stdin.write = () => {
		const error = new Error('EPIPE: broken pipe, write');
		error.code = 'EPIPE';
		throw error;
	};
	const server = makeServer(child);
	const outcome = await settle(server.start());
	check('start() 以 rejection 结束，而不是同步抛出', outcome.ok, false);
	check('状态变 failed', server.state, 'failed');

	let disposed = false;
	try {
		server.dispose('test');
		disposed = true;
	} catch {
		disposed = false;
	}
	check('断管后 dispose 不抛错', disposed, true);
}

console.log(`lean-server: ${passed}/${passed + failures.length} 通过`);
if (failures.length > 0) {
	console.log(failures.join('\n'));
	process.exit(1);
}
