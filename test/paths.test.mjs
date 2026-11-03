// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `src/paths.js` 的单测：把查看器给的相对路径接到会话 cwd 上。
 *
 * 背景（2026-11-03）：查看器给的 path 是「相对会话工作目录」的，宿主半拿
 * `process.cwd()` 去拼 → 目录不存在 → `lean --server` 起不来 → 浏览器每 4 秒
 * 一次 pull 不停重建 = 「切到某些文件 Lean 崩溃且一直重启失败」。
 */

import assert from 'node:assert';

import {
	isAbsolutePath,
	separatorOf,
	joinPath,
	absolutePathOf,
	sessionCwdOf,
	viewerPathOf,
} from '../src/paths.js';

let failed = 0;

function check(label, run) {
	try {
		run();
		console.log(`  ok   ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${label}`);
		console.log(`       ${error instanceof Error ? error.message : String(error)}`);
	}
}

const WIN = 'D:\\CodingSpace\\04';
const POSIX = '/home/dev/proj';

console.log('paths');

check('isAbsolutePath 认盘符路径（反斜杠与正斜杠都算）', () => {
	assert.equal(isAbsolutePath('C:\\a\\b.lean'), true);
	assert.equal(isAbsolutePath('C:/a/b.lean'), true);
	assert.equal(isAbsolutePath('c:\\a'), true);
});

check('isAbsolutePath 认 UNC 与 posix 绝对路径', () => {
	assert.equal(isAbsolutePath('\\\\server\\share\\x.lean'), true);
	assert.equal(isAbsolutePath('/home/dev/x.lean'), true);
});

check('isAbsolutePath 拒相对路径与空值', () => {
	assert.equal(isAbsolutePath('施工方案/PlanSpec.lean'), false);
	assert.equal(isAbsolutePath('a/b.lean'), false);
	assert.equal(isAbsolutePath('./x.lean'), false);
	assert.equal(isAbsolutePath(''), false);
	assert.equal(isAbsolutePath(undefined), false);
	assert.equal(isAbsolutePath(null), false);
	assert.equal(isAbsolutePath(42), false);
});

check('separatorOf 按基准选分隔符', () => {
	assert.equal(separatorOf(WIN), '\\');
	assert.equal(separatorOf(POSIX), '/');
	assert.equal(separatorOf(''), '/');
	assert.equal(separatorOf(undefined), '/');
	/* 混着写（有 / 也有 \）时按 posix 处理，避免拼出更多怪东西。 */
	assert.equal(separatorOf('D:\\a/b'), '/');
});

check('joinPath 把相对的接到 Windows 基准上', () => {
	assert.equal(joinPath(WIN, '施工方案/PlanSpec.lean'), 'D:\\CodingSpace\\04\\施工方案\\PlanSpec.lean');
	assert.equal(joinPath(WIN, '施工方案\\PlanSpec.lean'), 'D:\\CodingSpace\\04\\施工方案\\PlanSpec.lean');
	assert.equal(joinPath(WIN, './x.lean'), 'D:\\CodingSpace\\04\\.\\x.lean');
});

check('joinPath 去掉基准尾部分隔符与前导分隔符，不产生双分隔符', () => {
	assert.equal(joinPath('D:\\a\\', 'b.lean'), 'D:\\a\\b.lean');
	assert.equal(joinPath('D:\\a\\\\', 'b.lean'), 'D:\\a\\b.lean');
	assert.equal(joinPath('/a/', '/b.lean'), '/a/b.lean');
	assert.equal(joinPath('/a', '/b/c.lean'), '/a/b/c.lean');
});

check('joinPath 空基准时只返回相对部分', () => {
	assert.equal(joinPath('', 'a/b.lean'), 'a/b.lean');
	assert.equal(joinPath(undefined, 'a/b.lean'), 'a/b.lean');
});

check('absolutePathOf 对绝对路径原样返回', () => {
	assert.equal(absolutePathOf(WIN, 'C:\\other\\x.lean'), 'C:\\other\\x.lean');
	assert.equal(absolutePathOf(WIN, '/already/abs.lean'), '/already/abs.lean');
	assert.equal(absolutePathOf(WIN, '\\\\srv\\share\\x.lean'), '\\\\srv\\share\\x.lean');
});

check('absolutePathOf 对相对路径拼接', () => {
	assert.equal(absolutePathOf(WIN, 'a/b.lean'), 'D:\\CodingSpace\\04\\a\\b.lean');
	assert.equal(absolutePathOf(POSIX, 'a/b.lean'), '/home/dev/proj/a/b.lean');
});

check('absolutePathOf 拿不到基准时原样返回（不猜）', () => {
	assert.equal(absolutePathOf(undefined, 'a/b.lean'), 'a/b.lean');
	assert.equal(absolutePathOf('', 'a/b.lean'), 'a/b.lean');
	assert.equal(absolutePathOf(null, 'a/b.lean'), 'a/b.lean');
});

check('absolutePathOf 空值与非字符串原样透传', () => {
	assert.equal(absolutePathOf(WIN, ''), '');
	assert.equal(absolutePathOf(WIN, undefined), undefined);
	assert.equal(absolutePathOf(WIN, null), null);
});

check('sessionCwdOf 从会话列表取 cwd', () => {
	const ctx = {
		sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: WIN } } }) } },
	};
	assert.equal(sessionCwdOf(ctx, 's1'), WIN);
});

check('sessionCwdOf 各种缺失都返回 undefined 不抛', () => {
	assert.equal(sessionCwdOf(undefined, 's1'), undefined);
	assert.equal(sessionCwdOf({}, 's1'), undefined);
	assert.equal(sessionCwdOf({ sessions: {} }, 's1'), undefined);
	assert.equal(sessionCwdOf({ sessions: { list: { getSnapshot: () => ({ byId: {} }) } } }, 's1'), undefined);
	assert.equal(
		sessionCwdOf({ sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '' } } }) } } }, 's1'),
		undefined,
	);
	assert.equal(
		sessionCwdOf(
			{
				sessions: {
					list: {
						getSnapshot: () => {
							throw new Error('boom');
						},
					},
				},
			},
			's1',
		),
		undefined,
	);
	assert.equal(sessionCwdOf({ sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: WIN } } }) } } }, ''), undefined);
	assert.equal(sessionCwdOf({ sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: WIN } } }) } } }, 42), undefined);
});

check('viewerPathOf 把相对路径拼到会话目录上（含非 ASCII 目录名）', () => {
	const ctx = {
		sessions: {
			list: {
				getSnapshot: () => ({ byId: { s9: { cwd: 'D:\\CodingSpace\\CODE-SPACE\\04' } } }),
			},
		},
	};
	assert.equal(
		viewerPathOf(ctx, 's9', '施工方案/PlanSpec.lean'),
		'D:\\CodingSpace\\CODE-SPACE\\04\\施工方案\\PlanSpec.lean',
	);
});

check('viewerPathOf 没有会话列表时原样返回，交给宿主半报 unknown-file', () => {
	assert.equal(viewerPathOf(undefined, 's9', '施工方案/PlanSpec.lean'), '施工方案/PlanSpec.lean');
	assert.equal(viewerPathOf(undefined, 's9', 'C:\\abs\\x.lean'), 'C:\\abs\\x.lean');
});

if (failed > 0) {
	console.log(`\npaths: ${failed} 项失败`);
	process.exit(1);
}
console.log('\npaths: 全部通过');
