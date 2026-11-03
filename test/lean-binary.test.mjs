// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 纯函数测试：不 spawn、不碰真文件系统（依赖全注入）。
//
// 这段逻辑的价值全在「找错二进制就会卡住两分钟」，所以每个分支都要钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';

import { compareVersion, encodeToolchain, readDefaultToolchain, readToolchainFile, resolveLeanBinary } from '../src/host/lean-binary.js';

/** 用内存文件系统造一个 deps 集合。 */
function fakeFs(files, dirs = []) {
	const set = new Map(Object.entries(files));
	return {
		join: win32.join,
		dirname: win32.dirname,
		basename: win32.basename,
		platform: 'win32',
		exists: (path) => set.has(path) || dirs.includes(path),
		readFile: (path) => {
			if (!set.has(path)) throw new Error(`ENOENT ${path}`);
			return set.get(path);
		},
		listDir: (path) => {
			const prefix = `${path}\\`;
			const names = new Set();
			for (const key of set.keys()) {
				if (!key.startsWith(prefix)) continue;
				names.add(key.slice(prefix.length).split('\\')[0]);
			}
			return [...names];
		},
	};
}

const ELAN = 'C:\\Users\\me\\.elan';
const V435 = `${ELAN}\\toolchains\\leanprover--lean4---v4.35.0\\bin\\lean.exe`;
const V430 = `${ELAN}\\toolchains\\leanprover--lean4---v4.30.0\\bin\\lean.exe`;

test('encodeToolchain 复刻 elan 的目录编码', () => {
	assert.equal(encodeToolchain('leanprover/lean4:v4.35.0'), 'leanprover--lean4---v4.35.0');
	assert.equal(encodeToolchain('leanprover/lean4:nightly-2024-01-01'), 'leanprover--lean4---nightly-2024-01-01');
	assert.equal(encodeToolchain('  '), '');
});

test('compareVersion 按数字段比较', () => {
	assert.equal(compareVersion('v4.35.0', 'v4.30.0'), 1);
	assert.equal(compareVersion('v4.9.0', 'v4.10.0'), -1);
	assert.equal(compareVersion('v4.30.0', 'v4.30.0'), 0);
});

test('lean-toolchain 钉住的版本优先于 elan 默认', () => {
	const deps = fakeFs({
		[`${ELAN}\\settings.toml`]: 'default_toolchain = "leanprover/lean4:v4.30.0"\n',
		'D:\\work\\lean-toolchain': 'leanprover/lean4:v4.35.0\n',
		[V435]: '',
		[V430]: '',
	});
	const hit = resolveLeanBinary({ root: 'D:\\work\\sub', elanHome: ELAN }, deps);
	assert.equal(hit.command, V435);
	assert.match(hit.source, /lean-toolchain/);
});

test('lean-toolchain 向上查找最多 12 级', () => {
	const deps = fakeFs({ 'D:\\lean-toolchain': 'leanprover/lean4:v4.30.0\n', [V430]: '' });
	const hit = resolveLeanBinary({ root: 'D:\\a\\b\\c', elanHome: ELAN }, deps);
	assert.equal(hit.command, V430);
});

test('没有 lean-toolchain 时用 elan 默认 toolchain', () => {
	const deps = fakeFs({ [`${ELAN}\\settings.toml`]: 'default_toolchain = "leanprover/lean4:v4.35.0"\n', [V435]: '' });
	const hit = resolveLeanBinary({ root: 'D:\\work', elanHome: ELAN }, deps);
	assert.equal(hit.command, V435);
	assert.match(hit.source, /elan default/);
});

test('默认 toolchain 没装时退到已安装的最新版本', () => {
	const deps = fakeFs({
		[`${ELAN}\\settings.toml`]: 'default_toolchain = "leanprover/lean4:v9.9.9"\n',
		[V435]: '',
		[V430]: '',
	});
	const hit = resolveLeanBinary({ root: 'D:\\work', elanHome: ELAN }, deps);
	assert.equal(hit.command, V435, '应挑 4.35.0 而不是 4.30.0');
	assert.match(hit.source, /installed/);
});

test('一个 toolchain 都没有时明确标注回退到 PATH（慢路径）', () => {
	const deps = fakeFs({});
	const hit = resolveLeanBinary({ root: 'D:\\work', elanHome: ELAN }, deps);
	assert.equal(hit.command, 'lean');
	assert.match(hit.source, /PATH fallback/);
});

test('ELAN_HOME 从 env 读取；非 Windows 不加 .exe', () => {
	const binary = '/elan/toolchains/leanprover--lean4---v4.35.0/bin/lean';
	const deps = {
		join: posix.join,
		dirname: posix.dirname,
		basename: posix.basename,
		platform: 'linux',
		env: { ELAN_HOME: '/elan', HOME: '/home/me' },
		exists: (path) => path === binary,
		readFile: (path) => {
			throw new Error(`ENOENT ${path}`);
		},
		listDir: (path) => (path === '/elan/toolchains' ? ['leanprover--lean4---v4.35.0'] : []),
	};
	const hit = resolveLeanBinary({ root: '/w' }, deps);
	assert.equal(hit.command, binary);
});

test('readToolchainFile 跳过空行取第一行有效内容', () => {
	const deps = fakeFs({ 'D:\\w\\lean-toolchain': '\n\nleanprover/lean4:v4.35.0\n' });
	assert.equal(readToolchainFile('D:\\w', deps), 'leanprover/lean4:v4.35.0');
});

test('readDefaultToolchain 缺文件时返回 null', () => {
	const deps = fakeFs({});
	assert.equal(readDefaultToolchain(ELAN, deps), null);
});
