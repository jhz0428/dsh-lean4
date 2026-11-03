// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// 打进浏览器半的 infoview 入口：只把 renderInfoview 挂到全局，其余都由它自己管。
//
// 这里的 `@leanprover/infoview` 是 npm 上的预构建 dist（ESM，react/react-dom 为外部依赖），
// 由 rolldown 把 React 18 一起打进来，避免运行时再搞 import map。

import { renderInfoview } from '@leanprover/infoview';

globalThis.__DCH_INFOVIEW__ = { renderInfoview };
