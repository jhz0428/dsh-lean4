// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 构建第一段：把 CodeMirror 6 打成 IIFE（模块作用域的 `var DCM`）。
//
// 用 rolldown，版本从 devDependencies 里取（见 tools/deps.mjs）——它同时是
// better-sidebar 自己在用的打包器，版本同源能避免打包结果漂移。
// 入口是本包的 tools/codemirror-entry.js，`@codemirror/*` 按 Node 规则解析。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { packageRoot, resolveRolldownCli, tmpDir } from './deps.mjs';

const entry = join(packageRoot, 'tools', 'codemirror-entry.js');
const output = join(tmpDir, 'cm.js');
const cli = resolveRolldownCli();

if (!existsSync(entry)) throw new Error(`缺少入口：${entry}`);

mkdirSync(dirname(output), { recursive: true });

const args = [cli, entry, '--format', 'iife', '--name', 'DCM', '--file', output, '--platform', 'browser', '--minify'];
execFileSync(process.execPath, args, { cwd: packageRoot, stdio: 'inherit' });

console.log(`work/tmp/cm.js: ${statSync(output).size} 字节`);
