# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。条目按版本从新到旧排列；
每个版本内按「新增 / 变更 / 修复 / 文档」分组，只记对使用者有意义的变化。

## 未发布

## 0.9.2 — 2026-11-03

为公开发布做准备：构建可以在任何一台机器上复现，测试不再依赖本机的开发者目录布局。

### 新增

- `tools/deps.mjs`：统一的依赖定位入口。优先用本包 `node_modules`，再走 Node 常规解析
  （覆盖 hoisted / workspace 布局），最后才退回旧开发布局。`tools/build-*.mjs` 全部改用它，
  不再写死 `../../work/upstream/...` 这类路径。
- `tools/check-syntax.mjs`（`npm run check`）：对 `src/`、`tools/`、`test/` 的 61 个文件
  跑 `node --check`。项目里真发生过「构建脚本把 import/export 剥错」「字符串里混进真换行」
  这类只有语法检查才抓得住的错。
- `devDependencies`：`rolldown`、`@codemirror/*`、`@leanprover/infoview` + `react@18`、
  `katex`，**全部钉死到精确版本**，并提交 `package-lock.json`。
- `.github/workflows/ci.yml`：Ubuntu + Windows × Node 20/22 四组合跑
  `npm ci → build → check → test`，另有一条独立任务断言 tarball 里确实带 `lib/`。
- `.gitattributes`、`.editorconfig`：自有源码统一 LF，二进制文件不做文本处理。
- `test/fixtures/sample.lean`：测试用的 Lean 样本，不再引用包外的文件。

### 变更

- 「确定性构建」的前提写清楚了：同一套钉死的依赖能产出逐字节一致的文件，
  升级依赖版本会改变产物字节（`@codemirror/state` 6.7.1 → 6.7.6 就让
  `work/tmp/cm.js` 从 382,839 变成 389,259 字节）。
- `npm run build` 现在也包含 `build:host`（此前只打客户端半，宿主半要单独跑）。
- `build-infoview.mjs` 加了一条守卫：bundle 小于 200 KB 直接报错。
  （依赖没解析上时 rolldown 会安静地打出一个只剩全局赋值的空壳。）

### 修复

- `test/markdown-math.test.mjs` 读的是包外的 `../../../work/tmp/katex.js`，
  外部克隆者跑不通；改成包内路径，并在文件缺失时给出「先跑 `npm run build`」的提示。
- `test/lean-mode.test.mjs` 读的是包外的 `001.lean`；改用包内 fixture。

## 0.9.1 — 2026-11-02

### 变更

- 许可证改为 **MPL-2.0**（逐文件 copyleft）。来自 vscode-lean4 的 Apache-2.0 内容
  按 MPL §1.7 Larger Work 与 §3.3 分文件隔离：
  - `src/third-party/goals-accomplished-icon.js`（对勾图标素材，Apache-2.0）
  - 内嵌的 `@leanprover/infoview` 0.14.0（Apache-2.0，未修改）
  - `LICENSE-APACHE-2.0` 保留上游许可全文
- 每个自有源文件加 `SPDX-License-Identifier: MPL-2.0` 头；构建产物头部说明它是多许可聚合体。
- `package.json` 的 `files` 增加 `src`（MPL §3.2(a) 源码可得性）。
- 新增 `prepack`：打包前自动重建 `lib/`，保证 tarball 里的产物是最新的。

## 0.9.0 — 2026-11-02

### 变更

- 插件改名 `dsh-lean-editor` → **`dsh-lean4`**（目录、包名、`cordis.patch.yml` 的 id、
  localStorage 键、profile 里的 `dependencies` 与 `dsh.profile.bundles`）。
  旧的 infoview 配置键会自动迁移到新键。`VIEWER_ID` 保持不变，避免已有用户
  `viewersEnabled` 偏好被重置。
- 附 Apache-2.0 全文与 `THIRD-PARTY-NOTICES.md`。

## 0.8.1 — 2026-11-02

### 修复

- **切换到某些 Lean 文件时 Lean「崩溃且重启失败」**：查看器传的是相对会话工作目录的路径，
  宿主半拿进程 cwd 拼接，得到一个不存在的目录，`spawn` 的 cwd 无效 → 子进程起不来 →
  浏览器每 4 秒的 pull 又触发重建，形成雪崩。现在客户端用
  `ctx.sessions.list` 里的会话 cwd 把路径转成绝对路径；宿主半对不存在的文件返回
  `unknown-file`，对不存在的工程根直接报错。
- 新增失败退避与熔断：1/2/4/8/16/30 秒退避，连续 6 次失败后停下，等用户点「重启」。
  Lean 子进程退出时把退出码、信号与 stderr 尾巴写进宿主日志。
- Agent 工具在真机一个都没注册上（`cannot get property "tools" without inject`）：
  `ctx.inject(['tools'], cb)` 的回调参数才是带 `tools` 的子 ctx。

## 0.8.0 — 2026-11-02

### 新增

- **9 个进程内 Agent 工具**：`lean_diagnostics`、`lean_goal`、`lean_hover`、
  `lean_completion`、`lean_definition`、`lean_references`、`lean_code_actions`、
  `lean_outline`、`lean_search`。坐标对 LLM 一律 1 基；`lean_diagnostics` 会等到
  Lean 精化安静下来才返回。
- 工具走进程内调用，**不经 HTTP**：`/lean-lsp/api` 的准入要求浏览器会话，
  裸 `fetch` 一律 403，这是刻意的。

## 0.7.0 — 2026-11-02

### 新增

- infoview 的 13 项配置可以改并持久化（`saveConfig` 从空实现变成真的合并 + 回灌）。
- 代码折叠：拉 `textDocument/foldingRange`，「折叠所有证明」按行首关键字挑；
  Lean 实际上从不发 `kind: 'proof'`（只有 comment/imports/region）。
- 「Try this」建议：`textDocument/codeAction`，右栏「建议」页签 + 右键应用。
- 跳转家族：Ctrl+Click 定义、查找引用、文档大纲、工作区符号搜索。
- task gutter：错误、警告、未完成目标、处理中（`$/lean/fileProgress`）。

### 修复

- 宿主半 `handle()` 的位置校验曾经无条件执行，把 `documentSymbol`/`workspaceSymbol`/
  `codeActions`/`diagnostics`/`foldingRange` 全挡成 `bad-request`，
  导致右栏的大纲、引用、建议、诊断四个页签一直是空的。

## 0.6.0 — 2026-10-30

### 新增

- 注释里的 LaTeX 公式：`$…$` 行内、`$$…$$` 块级，用 KaTeX 渲染。
  只内联 KaTeX 的 JS（273 KB），CSS 与字体借用 DSH 宿主页面已经加载的那一份。

## 0.5.x — 2026-10-30

### 新增

- `/-- … -/` 与 `/-! … -/` 文档注释就地渲染成 markdown（零依赖渲染器）。
- 行号栏的「证明完成」对勾（`leanTags: [2]` 的静默诊断）与「处理中」半圆。

### 修复

- 注释渲染块与行号错位、方向键跳行：块 widget 的垂直 `margin` 不会被
  `getBoundingClientRect()` 计入，导致高度图与实际布局累积偏移；改成 `padding`，
  并给 widget 补 `estimatedHeight`。
- 「Outdated RPC session」：Lean 的数字错误码 `-32900` 在四层链路上被降级成字符串，
  infoview 判不出来就不重连。现在原样透传；keepAlive 从 15 秒改成 10 秒。

## 0.4.0 — 2026-10-26

### 新增

- 右键菜单：「添加到对话」（选中部分 / 整篇）、复制、跳转等。
- 深色界面下的选区配色修复（CodeMirror 主题要显式 `{ dark: true }`）。

## 0.3.0 — 2026-10-26

### 新增

- 接入官方 `@leanprover/infoview`：目标、假设、消息、widget 都来自上游前端，
  右侧分栏常驻；`$/lean/rpc/connect` + 10 秒 keepAlive。

## 0.2.x — 2026-10-26

### 新增

- LSP：诊断（含 `lintGutter` 波浪线）、悬停、补全、目标面板（`$/lean/plainGoal`）。
- 宿主半路由 `/lean-lsp/api` 与 `/lean-lsp/events`（SSE + 4 秒 pull 兜底）。

### 修复

- Lean 启动慢 40 倍：PATH 上的 `lean` 是 elan 的壳，会联网查版本；改成直接 spawn
  toolchain 里的 `lean.exe`（初始化从 50 秒降到毫秒级）。
- 505 秒超时与 405：`ctx.baseDir` 未在 `inject` 里声明会抛错，`apply` 静默失败导致路由没注册。

## 0.1.0 — 2026-10-25

### 新增

- 第一个可用版本：认领 `.lean` 后缀，自带 CodeMirror 6 编辑器与 Lean 4 分词器，
  支持编辑与保存（`sidebar/write`，带 `expectedMtimeMs` 的并发三态）。
