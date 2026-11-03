// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 宿主半的落地日志。
//
// 为什么不用 `ctx.logger`：桌面端的日志只有崩溃包，`console` 进不了任何文件，
// 之前排查「lean 进程被谁杀了」「路由到底注册没注册」时完全拿不到证据。
// 这里写进插件目录旁边的 `work/logs/lean-host.log`，出问题直接读文件。
//
// 只在宿主半用：浏览器半没有 fs，构建时也不会把它内联进 client bundle。

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认落在 `projects/fileviewer-highlight/work/logs/lean-host.log`。 */
const DEFAULT_LOG_FILE = fileURLToPath(new URL('../../../work/logs/lean-host.log', import.meta.url));
const MAX_BYTES = 1024 * 1024;

let target = DEFAULT_LOG_FILE;
let broken = false;

/** 换一个日志文件（测试或特殊部署用）；传 `null` 关掉落地。 */
export function setLogFile(file) {
  target = file === null ? null : String(file);
  broken = false;
}

/** 当前日志路径（测试断言用）。 */
export function logFile() {
  return target;
}

function stamp() {
  const now = new Date();
  return now.toISOString().slice(11, 23);
}

/**
 * 写一行日志。任何 IO 失败都静默：日志不该把插件自身拖死。
 */
export function hostLog(message) {
  const line = `${stamp()} ${message}\n`;
  if (target === null || broken) return;
  try {
    mkdirSync(dirname(target), { recursive: true });
    try {
      if (statSync(target).size > MAX_BYTES) writeFileSync(target, '');
    } catch {
      // 文件还不存在，忽略。
    }
    appendFileSync(target, line);
  } catch {
    broken = true;
  }
}
