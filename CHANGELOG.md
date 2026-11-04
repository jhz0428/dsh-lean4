# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 内部开发期间版本号曾到过 `0.9.2`；对外发布从 `0.1.0` 重新起算。

## 0.1.1 — 2026-11-04

修复「Lean 进程退出后残留写入把整个 DSH 宿主打死」：

- **stdin/stdout/stderr 一律挂 `error` 监听**：`lean --server` 结束后管道里的 `write EPIPE` 过去会变成未捕获异常，而 DSH 宿主把任何未捕获异常当致命错误（写 stderr 后 `exit(1)`），桌面端表现为「应用无法启动或已意外停止」并弹三按钮恢复框。现在写失败只记日志、拒掉等待中的请求、把服务器状态标成 `failed`，宿主继续活着。
- **断管后 `send()` 立即给出可读错误**（`the Lean server is not running (EPIPE: …)`），不再等到 30s 请求超时，也不再往已经死掉的管道里堆积写；`write` 同步抛错走同一条记账路径。
- **`snapshot().stderr` 带上这次流错误**，事后排查不用再猜。
- `restart()` 清掉断管状态；`dispose()` 在断管后仍然安全。
- 新增 `test/lean-server.test.mjs`（14 项，注入假 spawn，不启动真 Lean），并加进 `npm test`。

## 0.1.0 — 2026-11-03

首个公开发布。

- **编辑器**：认领 `.lean` 后缀，自带 CodeMirror 6（Lean 4 分词、行号、主题自适应、选区配色），`Mod-S` 保存并检测并发修改；超大文件走提示分支。
- **语言服务**：诊断、悬停、补全、跳转定义、查找引用、文档大纲、工作区搜索、代码折叠、Try this 建议；服务器按项目根池化，绕开 elan 壳直接 spawn toolchain 里的 `lean.exe`。
- **目标与注释**：内嵌官方 `@leanprover/infoview`；`/-- … -/`、`/-! … -/` 就地渲染 markdown，支持 KaTeX 公式；行号栏显示证明完成与处理中标记。
- **Agent 工具**：九个进程内只读工具（`lean_diagnostics`、`lean_goal`、`lean_hover`、`lean_completion`、`lean_definition`、`lean_references`、`lean_code_actions`、`lean_outline`、`lean_search`），坐标为 1 基，不走 HTTP。
- **工程**：依赖钉死，`npm ci && npm run build` 可逐字节复现；CI 覆盖 Ubuntu/Windows × Node 20/22 并校验 tarball 内含 `lib/`。
- **许可**：自有代码 MPL-2.0；来自 vscode-lean4 的图标单独成文件（Apache-2.0），内嵌 infoview 亦为 Apache-2.0，全文见 `LICENSE-APACHE-2.0`。
