// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 宿主半的落地日志。
//
// 为什么不用宿主的 logger：桌面端的日志只有崩溃包，`console` 进不了任何文件，
// 排查「Lean 进程为什么退出」「路由注册没注册」时拿不到证据。这里落一个文件，
// 出问题直接读。默认在系统临时目录，可用 `setLogFile()` 改到别处。
//
// 只在宿主半用：浏览器半没有 fs，构建时也不会把它内联进 client bundle。

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 默认 `${tmpdir}/dsh-lean4-host.log`；超过 1 MiB 会先清空。 */
const DEFAULT_LOG_FILE = join(tmpdir(), 'dsh-lean4-host.log');
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
