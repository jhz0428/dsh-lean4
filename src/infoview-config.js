// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// infoview 的 13 个配置项：默认值、校验、持久化。
//
// 为什么需要这一层：infoview 自己有一份 UI（目标面板里的右键菜单、消息区的过滤按钮），
// 它通过 `EditorApi.saveConfig(conf)` 把用户的开关交回来，然后**等着宿主把结果再喂回去**
// （`InfoviewApi.changedInfoviewConfig`）。在 VS Code 里那一层由 settings.json 承担；
// 我们这里没有 settings.json，只能自己存 —— 存 localStorage，跨会话保持。
//
// 这个文件刻意不碰 DOM / 不碰 localStorage 本体：storage 由调用方传进来，
// 于是能在 Node 里用假对象把「脏数据怎么办」全部测掉。

/**
 * 与 `@leanprover/infoview` 的 `defaultInfoviewConfig` 逐字段一致
 * （证据：`dist/index.production.min.js` 开头的 `const l={allErrorsOnLine:!0,...}`）。
 * 这里烤一份副本是为了「模块没加载出来」时也有确定行为；运行时若能拿到 bundle 的
 * `defaultInfoviewConfig`，以 bundle 为准（见 `resolveDefaults`）。
 */
export const INFOVIEW_CONFIG_DEFAULTS = Object.freeze({
	allErrorsOnLine: true,
	autoOpenShowsGoal: true,
	debounceTime: 50,
	expectedTypeVisibility: 'Expanded by default',
	showGoalNames: true,
	emphasizeFirstGoal: false,
	reverseTacticState: false,
	hideTypeAssumptions: false,
	hideInstanceAssumptions: false,
	hideInaccessibleAssumptions: false,
	hideLetValues: false,
	showTooltipOnHover: true,
	messageOrder: 'Sort by proximity to text cursor',
});

/** `ExpectedTypeVisibility` 的全部取值（顺序即下拉框顺序）。 */
export const EXPECTED_TYPE_VISIBILITY = [
	'Expanded by default',
	'Collapsed by default',
	'Hidden',
];

/** `MessageOrder` 的全部取值。 */
export const MESSAGE_ORDER = [
	'Sort by proximity to text cursor',
	'Sort by message location',
];

/** localStorage 的键。带版本号，将来加字段时能安全地改形状。 */
export const INFOVIEW_CONFIG_KEY = 'dsh-lean4.infoview-config.v1';

/**
 * 改名前（插件还叫 `dsh-lean-editor` 时）用的键。
 *
 * 只读一次：读到就搬到新键下，之后不再看它。用户配过的那十三个开关不该因为改名丢一次。
 */
export const LEGACY_INFOVIEW_CONFIG_KEY = 'dsh-lean-editor.infoview-config.v1';

/** `debounceTime` 的合理区间：0 会让每次按键都打一次 RPC，太大则面板明显卡顿。 */
const DEBOUNCE_MIN = 0;
const DEBOUNCE_MAX = 5000;

/**
 * 面板里那几个开关的展示名。顺序即 UI 顺序。
 *
 * 只放布尔项：三个枚举与一个数字单独渲染（见 `CLIENT_BODY` 的「infoview 设置」段），
 * 混在一起会让这张表既不像表单也不像列表。
 */
export const INFOVIEW_TOGGLES = [
	['showGoalNames', '显示目标名'],
	['emphasizeFirstGoal', '强调第一个目标'],
	['reverseTacticState', '反转假设顺序'],
	['hideTypeAssumptions', '隐藏类型假设'],
	['hideInstanceAssumptions', '隐藏实例假设'],
	['hideInaccessibleAssumptions', '隐藏不可达假设'],
	['hideLetValues', '隐藏 let 的值'],
	['allErrorsOnLine', '一行显示全部错误'],
	['autoOpenShowsGoal', '自动展开目标'],
	['showTooltipOnHover', '悬停显示提示'],
];

/** 一个配置对象的「形状指纹」，用来判断两份配置是否等价（避免无意义的回灌）。 */
export function sameInfoviewConfig(left, right) {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
	for (const key of Object.keys(INFOVIEW_CONFIG_DEFAULTS)) {
		if (left[key] !== right[key]) return false;
	}
	return true;
}

/**
 * 把任意来源的对象收成一个合法的 `InfoviewConfig`。
 *
 * 三条规则，都是为了让「存进去的东西坏了」不至于把面板弄崩：
 * 1. 只认识默认表里的键——别的键丢掉（否则旧版本残留字段会被回灌给 infoview，
 *    而它对未知字段是会直接崩的）；
 * 2. 类型不对就用默认值，不做隐式转换（`"false"` 字符串当真值会把开关弄反）；
 * 3. 枚举越界、数字越界都夹回合法区间。
 */
export function sanitizeInfoviewConfig(raw, defaults = INFOVIEW_CONFIG_DEFAULTS) {
	const out = {};
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	for (const [key, fallback] of Object.entries(defaults)) {
		const value = source[key];
		if (typeof fallback === 'boolean') {
			out[key] = typeof value === 'boolean' ? value : fallback;
		} else if (typeof fallback === 'number') {
			const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
			out[key] = key === 'debounceTime'
				? Math.round(Math.min(DEBOUNCE_MAX, Math.max(DEBOUNCE_MIN, number)))
				: number;
		} else if (key === 'expectedTypeVisibility') {
			out[key] = EXPECTED_TYPE_VISIBILITY.includes(value) ? value : fallback;
		} else if (key === 'messageOrder') {
			out[key] = MESSAGE_ORDER.includes(value) ? value : fallback;
		} else {
			out[key] = typeof value === 'string' ? value : fallback;
		}
	}
	return out;
}

/**
 * 取默认值：优先用 bundle 自带的那份（`defaultInfoviewConfig`），
 * 拿不到就用烤进来的副本。这样上游改了默认值时我们不会悄悄落后。
 */
export function resolveDefaults(module) {
	const theirs = module?.defaultInfoviewConfig;
	if (theirs === null || typeof theirs !== 'object') return INFOVIEW_CONFIG_DEFAULTS;
	return sanitizeInfoviewConfig(theirs, INFOVIEW_CONFIG_DEFAULTS);
}

/** 读配置。storage 缺失、没存过、JSON 坏了、读了抛错 —— 全部安静地退回默认值。 */
export function readInfoviewConfig(storage, defaults = INFOVIEW_CONFIG_DEFAULTS) {
	if (storage === null || storage === undefined || typeof storage.getItem !== 'function') {
		return { ...defaults };
	}
	let text = null;
	try {
		text = storage.getItem(INFOVIEW_CONFIG_KEY);
		if (typeof text !== 'string' || text === '') {
			/* 改名迁移：老键里有就搬过来，搬不上去也不影响本次读取。 */
			const legacy = storage.getItem(LEGACY_INFOVIEW_CONFIG_KEY);
			if (typeof legacy === 'string' && legacy !== '') {
				text = legacy;
				try {
					storage.setItem(INFOVIEW_CONFIG_KEY, legacy);
				} catch {
					/* 配额满 / 隐私模式：本次先用着，下次再说。 */
				}
			}
		}
	} catch {
		return { ...defaults };
	}
	if (typeof text !== 'string' || text === '') return { ...defaults };
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ...defaults };
	}
	return sanitizeInfoviewConfig(parsed, defaults);
}

/**
 * 写配置。返回值表示「是否真的写进去了」——隐私模式 / 配额满时 `setItem` 会抛，
 * 那不是致命错误（本次会话仍然生效），但调用方值得知道。
 */
export function writeInfoviewConfig(storage, config, defaults = INFOVIEW_CONFIG_DEFAULTS) {
	if (storage === null || storage === undefined || typeof storage.setItem !== 'function') return false;
	try {
		storage.setItem(INFOVIEW_CONFIG_KEY, JSON.stringify(sanitizeInfoviewConfig(config, defaults)));
		return true;
	} catch {
		return false;
	}
}

/**
 * 把 infoview 交回来的补丁并进当前配置。
 *
 * `saveConfig` 收到的是**完整**配置（infoview 每次都是 `{...current, 某个字段}`），
 * 但我们仍然只取认识的键，免得它哪天多塞了字段把存储写脏。
 */
export function mergeInfoviewConfig(current, patch, defaults = INFOVIEW_CONFIG_DEFAULTS) {
	const base = sanitizeInfoviewConfig(current, defaults);
	const next = patch !== null && typeof patch === 'object' ? patch : {};
	return sanitizeInfoviewConfig({ ...base, ...next }, defaults);
}
