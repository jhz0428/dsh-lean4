# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **版本号说明**：这个插件在内部开发期间版本号一路涨到过 `0.9.2`。对外发布时按新仓库
> 重新从 `0.1.0` 起算——`0.1.0` 就是第一次公开发布，包含下面列出的全部能力。
> 之后每次发布都在这一节上面追加新条目。

## 0.1.0 — 2026-11-03

首个公开发布。

### 编辑器

- 自己认领 `.lean` 后缀（`FileViewerDescriptor` 的 `exts`），不复用 DSH 内置的纯文本查看器。
  原因见 README「为什么不能"注册一门语言"」：`languageForPath` 是一张硬编码的后缀表，
  插件拿不到 shiki，也没有注册新语法的钩子。
- 自带 CodeMirror 6（IIFE 打包，不依赖宿主的编辑器）：Lean 4 分词、行号、括号匹配、
  搜索、选区配色（深色界面下不会出现浅灰选区盖住浅色字）。
- 编辑 + 保存（`Mod-s`），写 `sidebar/write` 并带 `expectedMtimeMs`，并发冲突有
  `saved` / `conflict` / `failed` 三态提示。
- 右键菜单 8 项：添加到对话、复制、跳转到定义、查找引用、获取建议、文档大纲、
  折叠所有证明、展开全部。
- 超大文件（> 5 MiB）走提示分支，不挂编辑器。

### 语言服务（宿主侧桥接 `lean --server`）

- 诊断（含 `lintGutter` 波浪线）、悬停（320 ms）、补全、跳转到定义、查找引用、
  文档大纲、工作区符号搜索、类型定义、声明、高亮。
- 代码折叠：拉 `textDocument/foldingRange`，「折叠所有证明」按行首关键字挑——
  Lean 实际上从不发 `kind: 'proof'`，上游那句判断从未生效。
- 「Try this」：`textDocument/codeAction`，右栏「建议」页签 + 右键应用，
  请求时会把当前行的诊断一并带回去。
- 行号栏标记：证明完成对勾（`leanTags: [2]` 的静默诊断）、处理中圆盘
  （`$/lean/fileProgress`，区间截到三行）。
- 官方 `@leanprover/infoview` 0.14.0 挂在右侧分栏，目标/假设/消息/widget 都用上游前端；
  `$/lean/rpc/connect` + 10 秒 keepAlive；13 项 infoview 配置可改并持久化。
- 服务器按项目根池化（向上 12 级找 `lean-toolchain` / `lakefile.*` / `lean-manifest.json`），
  最多 3 个 LRU；15 秒 SSE 心跳 + 4 秒 pull 兜底；全文同步。
- 绕开 elan 壳直接 spawn toolchain 里的 `lean.exe`——PATH 上的 `lean` 会联网查版本，
  冷启动从 50 秒降到毫秒级。

### 注释与公式

- `/-- … -/` 与 `/-! … -/` 独占整行时就地渲染成 markdown（自带的零依赖渲染器：
  标题、列表、代码块、表格、引用、强调、链接）。
- 注释里的 LaTeX：`$…$` 行内、`$$…$$` 块级，用 KaTeX 渲染；写坏的公式原位退成红字，
  不会炸掉整段注释。
- 「添加到对话」把选中代码按 `路径:起-止` + lean 围栏塞进对话草稿。

### Agent 工具

九个**进程内**只读工具，给 LLM 用：`lean_diagnostics`、`lean_goal`、`lean_hover`、
`lean_completion`、`lean_definition`、`lean_references`、`lean_code_actions`、
`lean_outline`、`lean_search`。

- 坐标对调用方一律 **1 基**；`lean_diagnostics` 会等到 Lean 精化安静下来才返回。
- **不走 HTTP**：`/lean-lsp/api` 要求浏览器会话，裸 `fetch` 一律 403，这是刻意的。
- 不提供写文件工具——写仍走宿主的 `edit` / `write`，改完再用诊断回验。

### 工程

- 依赖全部钉死到精确版本，`npm ci && npm run build` 可逐字节复现（含 `package-lock.json`）。
- `npm run build`（codemirror → katex → infoview → client → host）、`npm run check`
  （61 个文件 `node --check`）、`npm test`（19 个文件 / 336 项断言，纯 Node）。
- GitHub Actions：Ubuntu + Windows × Node 20/22，另有一条任务断言 tarball 里确实带 `lib/`。
- 许可 **MPL-2.0**（逐文件 copyleft）。来自 vscode-lean4 的 Apache-2.0 内容分文件隔离：
  `src/third-party/goals-accomplished-icon.js` 与内嵌的 `@leanprover/infoview`，
  上游许可全文收在 `LICENSE-APACHE-2.0`。
- `lib/` 是构建产物、不入库，但 `package.json` 的 `files` 显式列了它，发布出去的
  tarball 自带产物；`prepack` 保证打包前重建。
