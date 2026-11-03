# dsh-lean4

[DSH](https://github.com/deepseek-ai) 侧边栏插件：让 [better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 能打开、编辑 `.lean` 文件，并接上本机的 Lean 语言服务器。

[![CI](https://github.com/jhz0428/dsh-lean4/actions/workflows/ci.yml/badge.svg)](https://github.com/jhz0428/dsh-lean4/actions/workflows/ci.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](./LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bf5.svg)](https://github.com/jhz0428/dsh-lean4)

<sub>**English** — A DSH sidebar plugin for Lean 4: claims `.lean` files with its own CodeMirror view and talks to a pooled `lean --server` — diagnostics, hover, completion, navigation, folding, code actions, the official infoview goal panel, in-place markdown rendering of doc comments (KaTeX), and nine read-only agent tools for LLMs. MPL-2.0.</sub>

---

## 功能

| | |
| --- | --- |
| 打开与编辑 | 认领 `.lean` 后缀，CodeMirror 6，行号、语法着色、深/浅色主题自适应、`Mod-S` 保存（带并发修改检测） |
| 语言服务 | 诊断波浪线、悬停、补全、跳转定义、查找引用、文档大纲、代码折叠、Try this 建议 |
| 目标面板 | 官方 `@leanprover/infoview` 直接嵌入右栏；服务器未就绪时退回内置目标列表 |
| 注释渲染 | `/-! … -/` 与 `/-- … -/` 就地渲染为 markdown，支持表格、代码块与 `$…$` / `$$…$$` 公式 |
| 行号栏标记 | 证明完成 ✓、Lean 正在处理 ◐ |
| Agent 工具 | 九个只读工具，LLM 在进程内查询 Lean，无需走 HTTP |
| 界面集成 | 右键菜单（添加到对话、跳转、引用、建议、大纲、折叠…）、右栏页签、状态栏 |

它不 fork、不打补丁、不改 better-sidebar 一个字节，卸载后 `.lean` 立刻回到原来的纯文本视图。

## 环境要求

- DSH 桌面端，并装有 `better-sidebar`（≥ 0.28）
- 本机 Lean 工具链（实测 Lean 4.30 / 4.35）；会优先按 `lean-toolchain` 找，其次 elan 默认版本
- 只有从源码构建时才需要 Node ≥ 20

## 安装

从 [Releases](https://github.com/jhz0428/dsh-lean4/releases) 下载 tarball，然后：

```bash
dsh plugin --profile desktop add "C:\path\to\dsh-lean4-0.1.0.tgz"
```

完全退出 DSH 再启动。卸载：

```bash
dsh plugin --profile desktop remove dsh-lean4
```

> 插件自带的 `cordis.patch.yml` 会被自动加载，**不要**再往 profile 里手写 `- id: lean4`。

## 使用

- `Mod-S` 保存；`Ctrl/Cmd` + 点击跳到定义
- 右键菜单：添加到对话、复制、跳转到定义、查找引用、获取建议、文档大纲、折叠所有证明、展开全部
- 右栏五个页签：目标、大纲、引用、建议、设置

## 配置

右栏「设置」页签可调 13 项 infoview 选项（是否显示类型假设、目标名、反序目标、消息排序、防抖时间等），存在浏览器 `localStorage` 的 `dsh-lean4.infoview-config.v1` 下。

Lean 二进制默认自动解析（`lean-toolchain` → elan 默认 → 已装最新 → `PATH`）。若自动解析不对，可在插件配置里显式给 `command`。

## Agent 工具

九个只读工具，供 LLM 直接查询当前 Lean 项目；坐标是 **1 基**的行/列。

| 工具 | 用途 |
| --- | --- |
| `lean_diagnostics` | 文件的诊断（可等 Lean 处理完） |
| `lean_goal` | 某位置的目标与假设 |
| `lean_hover` | 悬停信息 |
| `lean_completion` | 补全候选 |
| `lean_definition` | 跳转定义 |
| `lean_references` | 查找引用 |
| `lean_code_actions` | 该行可用的 Try this 建议 |
| `lean_outline` | 文件大纲 |
| `lean_search` | 全项目符号搜索 |

## 开发

```bash
npm ci
npm run build     # 构建 lib/client.js 与 lib/index.js
npm run check     # 语法检查
npm test          # 单元测试
```

产物是确定性的：同一套依赖下逐字节一致。`lib/` 不入库，但 `files` 显式列出了它，`prepack` 会先构建再打包。

```
src/           客户端（CodeMirror、markdown、LSP 客户端）与宿主半
src/host/      宿主半：lean-server、plugin、tools、路径与日志
tools/         构建脚本与两个 rolldown 入口
test/          单元测试（node:test，逐文件运行）
```

## 已知限制

- 只处理 `.lean`；没有 `\alpha` 缩写输入、Loogle、module hierarchy、`lakefile.toml` 校验
- 折叠区间来自 Lean，但「哪些是证明」由客户端按行首关键字判断
- 注释里的 `#html` widget 需要外网 CDN
- 需要本机装好 Lean；没有内置的版本管理
- 卸载后 `.lean` 回到纯文本查看

## 许可

自有代码 **MPL-2.0**（逐文件 copyleft）。两处 Apache-2.0 内容单独成文件，见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)：

- `src/third-party/goals-accomplished-icon.js` — 对勾图标，取自 vscode-lean4（Apache-2.0）
- 构建产物内嵌 `@leanprover/infoview` 0.14.0（Apache-2.0）

打包进 `lib/client.js` 的 CodeMirror 与 KaTeX 为 MIT。
