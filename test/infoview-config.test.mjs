// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// infoview 13 项配置的校验与持久化。
//
// 钉住的风险：localStorage 里存着上一版写下的东西。任何一个字段坏掉（类型变了、
// 枚举值被上游改名、有人手改过），都不该让目标面板白屏——这里全部安静退回默认值。
// 另一条同样重要：`"false"` 这种字符串**不能**被当成假值，隐式转换会把开关弄反。

import assert from 'node:assert/strict';
import {
	INFOVIEW_CONFIG_DEFAULTS,
	EXPECTED_TYPE_VISIBILITY,
	MESSAGE_ORDER,
	INFOVIEW_CONFIG_KEY,
	INFOVIEW_TOGGLES,
	sameInfoviewConfig,
	sanitizeInfoviewConfig,
	resolveDefaults,
	readInfoviewConfig,
	writeInfoviewConfig,
	mergeInfoviewConfig
} from '../src/infoview-config.js';

const cases = [];
function test(name, fn) {
	cases.push({ name, fn });
}

/** 假的 localStorage：能记、能读、能抛。 */
function memoryStorage(seed = {}) {
	const data = new Map(Object.entries(seed));
	return {
		data,
		getItem(key) {
			return data.has(key) ? data.get(key) : null;
		},
		setItem(key, value) {
			data.set(key, String(value));
		}
	};
}

test('默认值是 13 项，且与上游 defaultInfoviewConfig 的形状一致', () => {
	assert.deepEqual(Object.keys(INFOVIEW_CONFIG_DEFAULTS).sort(), [
		'allErrorsOnLine', 'autoOpenShowsGoal', 'debounceTime', 'emphasizeFirstGoal',
		'expectedTypeVisibility', 'hideInaccessibleAssumptions', 'hideInstanceAssumptions',
		'hideLetValues', 'hideTypeAssumptions', 'messageOrder', 'reverseTacticState',
		'showGoalNames', 'showTooltipOnHover'
	]);
	assert.equal(INFOVIEW_CONFIG_DEFAULTS.debounceTime, 50);
	assert.equal(INFOVIEW_CONFIG_DEFAULTS.allErrorsOnLine, true);
	assert.equal(INFOVIEW_CONFIG_DEFAULTS.hideLetValues, false);
});

test('默认值表是冻结的（别让某处代码悄悄改掉全局默认）', () => {
	assert.equal(Object.isFrozen(INFOVIEW_CONFIG_DEFAULTS), true);
});

test('两个枚举表的取值与渲染顺序', () => {
	assert.deepEqual(EXPECTED_TYPE_VISIBILITY, ['Expanded by default', 'Collapsed by default', 'Hidden']);
	assert.deepEqual(MESSAGE_ORDER, ['Sort by proximity to text cursor', 'Sort by message location']);
});

test('INFOVIEW_TOGGLES 只列布尔项，且都在默认值表里', () => {
	for (const [key] of INFOVIEW_TOGGLES) {
		assert.equal(typeof INFOVIEW_CONFIG_DEFAULTS[key], 'boolean', `${key} 不是布尔项`);
	}
	const booleans = Object.entries(INFOVIEW_CONFIG_DEFAULTS)
		.filter(([, value]) => typeof value === 'boolean')
		.map(([key]) => key);
	assert.deepEqual(INFOVIEW_TOGGLES.map(([key]) => key).sort(), booleans.sort(), '十个布尔项都要能被切换');
});

test('sanitizeInfoviewConfig 丢掉未知键', () => {
	const out = sanitizeInfoviewConfig({ showGoalNames: false, somethingNew: 1 });
	assert.equal(out.somethingNew, undefined);
	assert.equal(out.showGoalNames, false);
	assert.equal(Object.keys(out).length, 13);
});

test('sanitizeInfoviewConfig 不做隐式转换（"false" 不是 false）', () => {
	const out = sanitizeInfoviewConfig({ showGoalNames: 'false', debounceTime: '300' });
	assert.equal(out.showGoalNames, true, '字符串退回默认 true，而不是被当成假');
	assert.equal(out.debounceTime, 50, '字符串数字也不认');
});

test('sanitizeInfoviewConfig 夹住 debounceTime 并取整', () => {
	assert.equal(sanitizeInfoviewConfig({ debounceTime: 9999 }).debounceTime, 5000);
	assert.equal(sanitizeInfoviewConfig({ debounceTime: -5 }).debounceTime, 0);
	assert.equal(sanitizeInfoviewConfig({ debounceTime: 120.6 }).debounceTime, 121);
	assert.equal(sanitizeInfoviewConfig({ debounceTime: NaN }).debounceTime, 50);
	assert.equal(sanitizeInfoviewConfig({ debounceTime: Infinity }).debounceTime, 50);
});

test('sanitizeInfoviewConfig 对越界的枚举退回默认', () => {
	const out = sanitizeInfoviewConfig({ messageOrder: 'bogus', expectedTypeVisibility: 'nope' });
	assert.equal(out.messageOrder, 'Sort by proximity to text cursor');
	assert.equal(out.expectedTypeVisibility, 'Expanded by default');
});

test('sanitizeInfoviewConfig 对非法输入整体退回默认', () => {
	for (const bad of [null, undefined, 'x', 42, []]) {
		assert.deepEqual(sanitizeInfoviewConfig(bad), { ...INFOVIEW_CONFIG_DEFAULTS });
	}
});

/* 显式写这条：数组是 object，`typeof [] === 'object'`，容易漏。 */
test('sanitizeInfoviewConfig 对空数组不崩（逐字段退回默认）', () => {
	const out = sanitizeInfoviewConfig([]);
	assert.equal(out.debounceTime, 50);
});

test('resolveDefaults 优先用 bundle 的 defaultInfoviewConfig', () => {
	const theirs = { ...INFOVIEW_CONFIG_DEFAULTS, debounceTime: 200 };
	assert.equal(resolveDefaults({ defaultInfoviewConfig: theirs }).debounceTime, 200);
});

test('resolveDefaults 拿不到 bundle 时用烤进来的副本', () => {
	assert.equal(resolveDefaults(null).debounceTime, 50);
	assert.equal(resolveDefaults({}).debounceTime, 50);
});

test('readInfoviewConfig 在没有 storage 时返回默认值', () => {
	assert.deepEqual(readInfoviewConfig(null), { ...INFOVIEW_CONFIG_DEFAULTS });
	assert.deepEqual(readInfoviewConfig({}), { ...INFOVIEW_CONFIG_DEFAULTS });
});

test('readInfoviewConfig 读回写进去的值', () => {
	const storage = memoryStorage();
	assert.equal(writeInfoviewConfig(storage, { ...INFOVIEW_CONFIG_DEFAULTS, reverseTacticState: true }), true);
	assert.equal(readInfoviewConfig(storage).reverseTacticState, true);
});

test('readInfoviewConfig 对坏 JSON 与空串退回默认', () => {
	assert.equal(readInfoviewConfig(memoryStorage({ [INFOVIEW_CONFIG_KEY]: '{oops' })).debounceTime, 50);
	assert.equal(readInfoviewConfig(memoryStorage({ [INFOVIEW_CONFIG_KEY]: '' })).debounceTime, 50);
	assert.equal(readInfoviewConfig(memoryStorage({ [INFOVIEW_CONFIG_KEY]: 'null' })).debounceTime, 50);
});

test('readInfoviewConfig 在 getItem 抛错时退回默认（隐私模式）', () => {
	const storage = { getItem() { throw new Error('denied'); } };
	assert.equal(readInfoviewConfig(storage).showGoalNames, true);
});

test('writeInfoviewConfig 在 setItem 抛错时返回 false 而不抛（配额满）', () => {
	const storage = { setItem() { throw new Error('quota'); } };
	assert.equal(writeInfoviewConfig(storage, INFOVIEW_CONFIG_DEFAULTS), false);
});

test('writeInfoviewConfig 写出去的是收过的干净数据', () => {
	const storage = memoryStorage();
	writeInfoviewConfig(storage, { debounceTime: 99999, junk: 'x' });
	const stored = JSON.parse(storage.getItem(INFOVIEW_CONFIG_KEY));
	assert.equal(stored.debounceTime, 5000);
	assert.equal(stored.junk, undefined);
});

test('mergeInfoviewConfig 只覆盖补丁里认识的字段', () => {
	const current = { ...INFOVIEW_CONFIG_DEFAULTS, showGoalNames: true, debounceTime: 50 };
	const next = mergeInfoviewConfig(current, { showGoalNames: false, alien: true });
	assert.equal(next.showGoalNames, false);
	assert.equal(next.debounceTime, 50);
	assert.equal(next.alien, undefined);
});

test('mergeInfoviewConfig 对坏补丁保持原值', () => {
	const current = { ...INFOVIEW_CONFIG_DEFAULTS, reverseTacticState: true };
	assert.equal(mergeInfoviewConfig(current, null).reverseTacticState, true);
	assert.equal(mergeInfoviewConfig(current, 'x').reverseTacticState, true);
	/* 坏类型的那个字段本身退回默认（false）——「宁可用错的值也不崩」这条线的取舍。 */
	assert.equal(mergeInfoviewConfig(current, { reverseTacticState: 'yes' }).reverseTacticState, false);
	/* 但同一次合并里的其它字段不受影响。 */
	assert.equal(mergeInfoviewConfig(current, { reverseTacticState: 'yes' }).showGoalNames, true);
});

test('sameInfoviewConfig 只比 13 个已知字段', () => {
	const base = { ...INFOVIEW_CONFIG_DEFAULTS };
	assert.equal(sameInfoviewConfig(base, { ...base }), true);
	assert.equal(sameInfoviewConfig(base, { ...base, alien: 1 }), true, '未知字段不影响等价判断');
	assert.equal(sameInfoviewConfig(base, { ...base, showGoalNames: false }), false);
	assert.equal(sameInfoviewConfig(base, null), false);
	assert.equal(sameInfoviewConfig(base, base), true);
});

let failed = 0;
for (const item of cases) {
	try {
		item.fn();
		console.log(`  ok  ${item.name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${item.name}`);
		console.log(`       ${error.message}`);
	}
}
console.log(`infoview-config: ${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;
