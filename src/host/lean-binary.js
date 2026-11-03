// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * 找到「真正的」lean 可执行文件，绕开 elan 的 shim。
 *
 * 为什么必须绕：`lean` 在 PATH 上其实是 `%USERPROFILE%\.elan\bin\lean.exe`，
 * 它是 elan 的分发壳——每次启动都要解析 toolchain，其中一步是**联网查询最新
 * release**。离线或受限网络下这一步会卡到超时（本机实测 `lean --version`
 * 超过 180 s 还没返回），表现为「语言服务器启动特别慢」。
 *
 * 直接执行 `~/.elan/toolchains/<编码后的 toolchain>/bin/lean.exe` 是毫秒级的。
 *
 * 依赖全部注入，便于单测：真实调用点只传 `root`。
 */

const MAX_WALK_UP = 12;

/** `leanprover/lean4:v4.35.0` → `leanprover--lean4---v4.35.0`（elan 的目录编码）。 */
export function encodeToolchain(spec) {
	const text = String(spec).trim();
	if (text === '') return '';
	return text.replace(/:/g, '---').replace(/\//g, '--');
}

/** Windows 上补 `.exe`；其它平台原样。 */
function withExe(base, platform) {
	return platform === 'win32' ? `${base}.exe` : base;
}

/**
 * 从 `root` 向上找 `lean-toolchain`，返回文件内容（第一行）。
 * 找不到返回 `null`。
 */
export function readToolchainFile(root, deps) {
	const { join, dirname, readFile, exists } = deps;
	let dir = root;
	for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
		const candidate = join(dir, 'lean-toolchain');
		if (exists(candidate)) {
			try {
				const text = readFile(candidate);
				const first = String(text).split('\n').map((line) => line.trim()).find((line) => line !== '');
				return first ?? null;
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** 读 elan 的 `settings.toml` 里的 `default_toolchain`。 */
export function readDefaultToolchain(elanHome, deps) {
	const { join, readFile, exists } = deps;
	const settings = join(elanHome, 'settings.toml');
	if (!exists(settings)) return null;
	try {
		const text = String(readFile(settings));
		const matched = /^\s*default_toolchain\s*=\s*"([^"]+)"/m.exec(text);
		return matched === null ? null : matched[1];
	} catch {
		return null;
	}
}

/**
 * 解析出可直接 spawn 的 lean 路径。
 *
 * 顺序：`lean-toolchain` → elan 默认 toolchain → 已安装的最新 `leanprover--lean4---*`
 * → PATH 上的 `lean`（最后的兜底，也就是慢路径）。
 *
 * @returns `{ command, source }`，`source` 说明命中了哪一条，方便写日志。
 */
export function resolveLeanBinary(options, deps) {
	const {
		join,
		basename,
		platform = process.platform,
		env = {},
		exists,
		readFile,
		listDir,
	} = deps;
	const elanHome = options.elanHome ?? env.ELAN_HOME ?? (env.USERPROFILE ?? env.HOME ? join(env.USERPROFILE ?? env.HOME, '.elan') : null);
	const tried = [];

	const attempt = (spec, source) => {
		const encoded = encodeToolchain(spec);
		if (encoded === '') return null;
		const binary = join(elanHome, 'toolchains', encoded, 'bin', withExe('lean', platform));
		tried.push(binary);
		return exists(binary) ? { command: binary, source } : null;
	};

	if (elanHome !== null) {
		const pinned = readToolchainFile(options.root, { join, dirname: deps.dirname, readFile, exists });
		if (pinned !== null) {
			const hit = attempt(pinned, `lean-toolchain: ${pinned}`);
			if (hit !== null) return hit;
		}
		const fallback = readDefaultToolchain(elanHome, { join, readFile, exists });
		if (fallback !== null) {
			const hit = attempt(fallback, `elan default: ${fallback}`);
			if (hit !== null) return hit;
		}
		/* 再退一步：已安装的 toolchain 里挑版本号最大的。 */
		try {
			const entries = listDir(join(elanHome, 'toolchains'))
				.filter((name) => name.startsWith('leanprover--lean4---'))
				.sort((left, right) => compareVersion(right, left));
			for (const entry of entries) {
				const binary = join(elanHome, 'toolchains', entry, 'bin', withExe('lean', platform));
				tried.push(binary);
				if (exists(binary)) return { command: binary, source: `installed: ${entry}` };
			}
		} catch {
			// toolchains 目录不存在，继续兜底。
		}
	}

	return { command: basename === undefined ? 'lean' : 'lean', source: `PATH fallback (slow: elan shim) — tried ${tried.length} candidates` };
}

/** `v4.35.0` 比 `v4.30.0` 大：按数字段比较，非数字段退化成字符串比较。 */
export function compareVersion(left, right) {
	const parts = (text) => String(text).match(/\d+|\D+/g) ?? [];
	const a = parts(left);
	const b = parts(right);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const x = a[index];
		const y = b[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = Number(x);
		const ny = Number(y);
		if (Number.isFinite(nx) && Number.isFinite(ny)) {
			if (nx !== ny) return nx < ny ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}
