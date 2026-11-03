# dsh-lean4

> 给 [DSH](https://github.com/deepseek-ai) 的 [better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)
> 用的 **Lean 4 编辑器插件**（[仓库](https://github.com/jhz0428/dsh-lean4)）：在侧边栏里打开 `.lean` 文件，得到带语法着色、行号、诊断波浪线、
> 官方 infoview 目标面板、可折叠证明、Try this 建议和一个能直接调用的 Lean 语言服务的编辑器。

[![CI](https://github.com/jhz0428/dsh-lean4/actions/workflows/ci.yml/badge.svg)](https://github.com/jhz0428/dsh-lean4/actions/workflows/ci.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](./LICENSE)
[![Lean 4](https://img.shields.io/badge/Lean-4.30%20%7C%204.35-7a4dff.svg)](https://lean-lang.org)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b8bf5.svg)](https://github.com/deepseek-ai)

<sub>**English** — `dsh-lean4` is a Lean 4 editor plugin for the DSH sidebar. It claims `.lean`
files with its own CodeMirror 6 view and talks to a pooled `lean --server` through a small
host-side bridge: diagnostics, hover, completion, go-to-definition, references, document outline,
folding, code actions, the official `@leanprover/infoview` goal panel, in-place markdown rendering
of doc comments (with KaTeX), and nine read-only **agent tools** that let an LLM query Lean
in-process instead of over HTTP. MPL-2.0, no fork of better-sidebar, uninstallable at will.</sub>

---

## 目录

- [它是什么](#它是什么)
- [为什么不能"注册一门语言"](#为什么不能注册一门语言)
- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [架构](#架构)
- [Agent 工具参考](#agent-工具参考)
- [构建](#构建)
- [测试](#测试)
- [发布](#发布)
- [故障排查](#故障排查)
- [已知限制与路线图](#已知限制与路线图)
- [目录结构](#目录结构)
- [许可](#许可)

---

## 它是什么

DSH 的文件查看器对未知后缀一律走「纯文本」兜底——没有着色、没有语言服务。
`.lean` 正好落在这一侧：DSH 的语言表里没有它，`@codemirror/lang-lean` 也不存在。

这个插件做两件事：

1. **认领 `.lean`**：注册一个自己的 file viewer（`exts: ['lean']`，priority 10，
   压过内置 `code` 兜底的 -100），里面是一套完整的 CodeMirror 6 编辑环境。
2. **接上 Lean 语言服务器**：浏览器里跑不了 `lean --server`，所以宿主半起子进程、做 LSP 桥，
   浏览器半用 HTTP + SSE 跟它说话。诊断、悬停、补全、目标、折叠、建议全从这条链路来。

它**不 fork、不打补丁、不改 better-sidebar 一个字节**，卸载后 `.lean` 立刻回到原来的纯文本视图。
功能面参照 [vscode-lean4](https://github.com/leanprover/vscode-lean4)。

## 为什么不能"注册一门语言"

better-sidebar 的内置文本编辑器这样取语言：

```ts
// better-sidebar: src/client/TextEditor.tsx
const language = languageForPath(path)
```

`languageForPath`（`src/client/lang.ts`）是一张**硬编码的 `switch`**，约 45 个后缀，
末尾 `default: return null` —— 没有 `lean`。

better-sidebar 给第三方的席位只有 `registerTab` 与 `registerFileViewer`，
而 `FileViewerDescriptor` 的全字段是：

```
id / title / icon / exts / priority / fetchStrategy / detect / load / settings / component
```

**没有一个字段能碰语言**。所以「给内置编辑器加一门语言」这条路对第三方是关着的。

能走的只有一条：**自己认领后缀，自己提供组件**。代价是自带一份 CodeMirror（约 383 KB 的 IIFE），
收益是零侵入、可卸载、不用跟上游同步。

## 功能

### 编辑与保存

| 能力 | 说明 |
| --- | --- |
| 着色 | 自写 `StreamLanguage` 分词器：行注释、可嵌套跨行块注释、字符串与字符字面量、数字、声明关键字、声明名、类型名、运算符 |
| 编辑 | 行号、撤销栈、括号匹配、`Ctrl+F` 搜索、Tab 缩进、深浅主题自动跟随挂载点文字色 |
| 保存 | `Mod-s` 或页头保存按钮 → `POST /sidebar/write?sessionId=&path=&expectedMtimeMs=`，body 是 LF 文档 |
| 并发 | `mtimeMs` 做乐观门禁；命中 409 不静默覆盖，弹横幅给「仍然保存 / 从磁盘重载」 |
| 外部变更 | 宿主自动刷新（模型改完文件）时换文档而不重挂，光标与撤销栈保留；dirty 时如实上报让宿主跳过 |
| 行号跳转 | `a.lean#L42` 打开时滚到该行并回报 `onLineConsumed` |
| 超大文件 | 超过宿主可编辑上限（5 MiB）时给提示，不挂载编辑器 |

### 语言服务

| 能力 | 说明 |
| --- | --- |
| 诊断 | `publishDiagnostics` → 行内波浪线 + gutter 标记，悬停看完整消息 |
| 悬停 | 光标停 320 ms → `textDocument/hover`，Markdown 里的代码块单独排版 |
| 补全 | `Ctrl+Space` 或输入标识符前缀自动弹出；候选上限 300、渲染上限 60 |
| 跳转 | `Ctrl+Click` 标识符 → `textDocument/definition`；同文件直接挪光标，别的文件给出 `Foo.lean:12:5` |
| 引用 | `textDocument/references` → 右栏「引用」页签，本文件与外部文件分开 |
| 大纲 | `textDocument/documentSymbol` → 右栏「大纲」页签，带搜索框、`L42` 行号、点击跳转 |
| 折叠 | `textDocument/foldingRange` + CodeMirror `foldService`：左侧折叠槽、`Ctrl+Shift+[` / `Ctrl+Shift+]`；右键「折叠所有证明 / 展开全部」 |
| Try this | 右键「获取建议」→ 带当前行诊断发 `textDocument/codeAction`，右栏「建议」页签列出，点「应用」就地替换 |
| 证明完成 | 服务器给 `leanTags: [2]`（`GoalsAccomplished`）的诊断时，该声明首行 gutter 打蓝色实心对勾 |
| 处理中 | `$/lean/fileProgress` 里 `kind: 0` 的区间在 gutter 打半实心圆盘（一列最多三行） |
| 目标面板 | 官方 `@leanprover/infoview` 挂在编辑器**右侧分栏**（可收起）：目标、假设、消息、widget、`#check`/`#eval` 输出都由它渲染 |
| 兜底目标 | infoview 不可用（bundle 缺失/挂载失败）时退回自带的极简面板，按 `$/lean/plainGoal` 逐条列出 |

### 注释与公式

| 能力 | 说明 |
| --- | --- |
| markdown 渲染 | `/-- … -/` 与 `/-! … -/` 独占整行时就地渲染（标题/段落/列表/代码块/引用/表格/公式）；**点注释正文即进入编辑**，光标落进去就还原源码，状态栏可整体切回源码 |
| 公式 | `$…$` 行内、`$$…$$` 独立成块，交给 KaTeX 0.16 排版（只内联它的 JS，CSS 与字体用宿主页面已有的那份）；写坏的公式就地退成红字，不连累整段 |

### Agent 工具

宿主进程内注册 9 个**只读**工具，LLM 不必绕 HTTP、也不必持有浏览器会话：

`lean_diagnostics` · `lean_goal` · `lean_hover` · `lean_completion` · `lean_definition` ·
`lean_references` · `lean_code_actions` · `lean_outline` · `lean_search`

明细见 [Agent 工具参考](#agent-工具参考)。

### 界面集成

| 能力 | 说明 |
| --- | --- |
| 添加到对话 | 右键把选区（无选区即整篇）以 `路径:起-止` + 围栏代码块追加进当前会话输入框 |
| infoview 设置 | 右栏「设置」页签暴露 infoview 的 13 个配置项（10 个开关 + `debounceTime` + 2 个枚举），存 localStorage 并在每次服务就绪后回灌 |
| 选区配色 | 选区/搜索命中/同名匹配用 `currentColor` 混合，深浅主题都可读 |

## 环境要求

| 项 | 要求 |
| --- | --- |
| DSH | 带 `webServer` / `connection` 服务与 `@deepseek-ai/dsh-tools` 的版本（插件用 `ctx.inject(['tools'], …)` 注册工具） |
| better-sidebar | **必需**，≥ 0.28（提供 `registerFileViewer` 与 `/sidebar/write`；插件的客户端 `inject` 就是 `dsh-better-sidebar`） |
| Lean | 4.30.0 / 4.35.0 实测通过；需要 `lean` 可执行文件。装法见 [elan](https://github.com/leanprover/elan)。**`lean-toolchain` 优先**，其次 elan 的 `default_toolchain`，再次已安装的最新 toolchain，最后才退回 PATH 上的 `lean` |
| 平台 | Windows 实测；代码里没有平台特定调用，macOS / Linux 未实测 |
| 构建 | Node ≥ 20（开发用 24.x）。宿主半构建产物只 import `node:` 内建，运行时无第三方依赖 |

## 安装

> 从本仓库安装时，先拿到带 `lib/` 的 tarball：GitHub Release 里的
> `dsh-lean4-<version>.tgz`，或本地 `npm ci && npm pack` 生成。
> **直接 clone 源码目录装不进去**——`lib/` 不入库，manifest 指向的入口文件不存在。


插件以 `link:` 或 tarball 装进某个 DSH profile：

```powershell
# 从 tarball（推荐；tarball 自带 lib/）
dsh plugin --profile desktop add "D:\path\to\dsh-lean4-0.1.0.tgz"

# 从源码目录（先构建，见「构建」）
npm run build
dsh plugin --profile desktop add "D:\path\to\dsh-lean4"
```

装完**完全退出桌面端再启动**（宿主半在启动时加载，热刷新只换浏览器半）。

**升级**：换 tarball 重新 `add` 即可，配置存在 localStorage 不受影响。

**卸载**：

```powershell
dsh plugin --profile desktop remove dsh-lean4
```

> ⚠️ **不要手写 profile 的 `cordis.patch.yml`**。本包自带的 `cordis.patch.yml` 用 `insert:` 注册，
> bundle 机制会加载它；再手写一条 `- id: lean4` 会变成重复行 / 重复 id。

## 使用

### 快捷键

| 键 | 作用 |
| --- | --- |
| `Mod-s` | 保存（走 better-sidebar 的写接口，带 `expectedMtimeMs`） |
| `Ctrl+Space` | 主动触发补全 |
| `Ctrl+Click` | 跳转到定义 |
| `Ctrl+F` / `Esc` | 搜索 / 关闭搜索 |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | 折叠 / 展开当前段（CodeMirror 默认折叠键位） |
| `Tab` | 缩进 |

### 右键菜单

添加到对话 · 复制选区 · 跳转到定义 · 查找引用 · 获取建议（Try this）· 文档大纲 · 折叠所有证明 · 展开全部

### 状态栏

从左到右：保存状态（`已保存` / `保存中` / 冲突提示）· 提示信息 · 注释渲染开关 ·
收起/展开信息面板 · Lean 状态（`Lean 就绪` / `启动中` / `未连接（原因）`）·「重启」

### 右栏页签

`目标` · `大纲` · `引用` · `建议` · `设置`。**infoview 始终挂在最上面不卸载**——切页签只换它
下面那一块，否则每次切换都要重建整个 infoview（重写目录、重连 RPC，很慢）。

## 配置

插件本身没有 DSH 设置项；可调的都在两处：

- **右栏「设置」页签**：infoview 的 13 项配置（`allErrorsOnLine`、`autoOpenShowsGoal`、
  `debounceTime`、`expectedTypeVisibility`、`showGoalNames`、`emphasizeFirstGoal`、
  `reverseTacticState`、`hideTypeAssumptions`、`hideInstanceAssumptions`、
  `hideInaccessibleAssumptions`、`hideLetValues`、`showTooltipOnHover`、`messageOrder`）。
  存 localStorage（键 `dsh-lean4.infoview-config.v1`），在每次服务器就绪后回灌给 infoview；
  infoview 自己的右键菜单改了也会同步回来。脏数据逐字段退回默认值，不做隐式类型转换。
- **Lean 可执行文件**：默认按「`lean-toolchain` → elan 默认 → 最新已安装 toolchain → PATH」解析
  （见 [环境要求](#环境要求)）。PATH 上的 `lean` 常是 elan 的壳，启动要联网查 release，
  可能慢 40 倍，所以插件默认绕开它。

## 架构

```
浏览器（DSH 客户端）                 宿主（DSH Node 进程）               子进程
──────────────────────────────────   ─────────────────────────────────   ─────────────
lib/client.js (CodeMirror 6)          lib/index.js (cordis 插件)          lean --server
  hoverTooltip        ──────────┐       POST /lean-lsp/api        ───►   JSON-RPC over stdio
  autocompletion                ├──►    { op: "hover", path, … }          （LSP 帧）
  lintGutter (诊断)             │       SSE  /lean-lsp/events     ◄───   publishDiagnostics
  官方 infoview（目标/widget）   ┘       每根 lake 项目一个服务器            $/lean/fileProgress
  Agent 工具  ◄────────── 进程内直调 ──►  op 复用同一套 handle()
```

浏览器半与宿主半通过 **一个 JSON 端点**说话，`op` 就是能力名：

```
pull · restart · stop · close · open · change · request · notify
hover · completion · definition · declaration · typeDefinition · references
documentHighlight · goal · termGoal · foldingRange · documentSymbol
workspaceSymbol · codeActions · diagnostics
```

### 关键设计决策

- **路由准入**：两条路由都用 `connection.requestRejection(req)` 判准入——和 better-sidebar
  自己的路由同一写法。裸 `fetch` 一律 403，所以 Agent 工具**不走 HTTP**，在进程内直接调
  `handle(body)`。安全模型不变，也不用冒用浏览器登录态。
- **服务器池**：按「项目根」池化，向上最多 12 级找 `lean-toolchain` / `lakefile.*` /
  `lean-manifest.json`，找不到就用文件所在目录；最多 3 个服务器 LRU 淘汰；15 s 心跳。
- **全文同步**：`didOpen` 一次，之后 `didChange` 带自增 `version`。Lean 文件本来不大，
  增量同步省不下什么，却要处理一堆边界。
- **4 s pull 兜底**：SSE 之外还有一个轮询。DSH 的 webServer 路由可能被代理缓冲成
  「连接 open 但事件永远不落地」，只信 SSE 会让诊断停在旧状态。`pull()` 用状态摘要去重，
  重复轮询不会造成重渲染。
- **keepAlive 10 s**：infoview 的目标/消息/widget 全走 `$/lean/rpc/call`，会话 30 s 不用
  就被服务器作废（`-32900 rpcNeedsReconnect`），所以每 10 s 发一次 `$/lean/rpc/keepAlive`。
  **数字错误码必须原样透传**到浏览器——中间任何一层把它降级成字符串，infoview 的重连判断
  就永远不成立（曾经的 `Outdated RPC session. Try again.` 就是这么来的）。
- **只认绝对路径**：查看器给的 `path` 可能是相对会话工作目录的，客户端先用会话的 `cwd`
  拼成绝对路径（`src/paths.js`）；宿主半拿到不存在的路径直接回 `unknown-file`，
  而不是把相对路径当成 profile 目录下的文件去 spawn Lean。
- **失败退避**：同一工程连续失败按 1/2/4/8/16/30 秒退避，连续 6 次仍失败就停止自动重启，
  要手动点「重启」——否则浏览器每 4 s 的 pull 会把「起不来」放大成雪崩。
- **注释渲染用块装饰**：`Decoration.replace({ block: true })` 会参与高度图，
  卡片的垂直留白必须是 `padding` 而不是 `margin`（`getBoundingClientRect()` 不含 margin，
  漏算会累积成「渲染块与行号错位」），并给 widget 提供 `estimatedHeight`。
- **KaTeX 只打包 JS**：DSH 页面本来就全局加载了 KaTeX 的样式与 woff2 字体，
  重复打包要白付约 28 万字符。

## Agent 工具参考

9 个只读工具。所有 `line` / `character` 都是 **1 基**（对外一律 1 基，内部才转 0 基），
返回里的位置也是 1 基，形如 `Foo.lean:12:5`。

| 工具 | 参数 | 返回要点 |
| --- | --- | --- |
| `lean_diagnostics` | `path`（必需）· `waitMs` · `severity`（`all`/`error`/`warning`） | 等语言服务器精化完成再答；`total` / `silent`（被滤掉的「目标已完成」装饰）/ `diagnostics[]`（`line`、`character`、`endLine`、`endCharacter`、`severity`、`message`、`code`） |
| `lean_goal` | `path` · `line` · `character` | 光标处的 `goals[]` 与 `termGoal`（`$/lean/plainGoal` / `plainTermGoal`） |
| `lean_hover` | `path` · `line` · `character` | `textDocument/hover` 的 Markdown |
| `lean_completion` | `path` · `line` · `character` | 最多 40 项，每项只留 `label` / `kind` / `detail` / `insertText` |
| `lean_definition` | `path` · `line` · `character` | `definition` / `declaration` / `typeDefinition` 归一成 `{path, line, character}` 列表 |
| `lean_references` | `path` · `line` · `character` | 引用位置列表 |
| `lean_code_actions` | `path` · `line` · `character` | 该行的 `textDocument/codeAction`（`exact?` / `apply?` 的 Try this），只保留落在本文件的编辑 |
| `lean_outline` | `path` | `documentSymbol` 拍平后的符号列表（`kind` 是短标签，如 `function`） |
| `lean_search` | `query`（必需）· `path` · `limit`（1–100，默认 20） | `workspace/symbol` 结果 |

要点：

- **不是 HTTP 接口**：工具在宿主进程内直调，不经过 `/lean-lsp/api`；
- **不写文件**：没有「应用建议」这类工具。要落盘走 DSH 自己的 `edit`/`write`，
  再用 `lean_diagnostics` 回验；
- **会等结果**：`lean_diagnostics` 默认最多等 10 s 让服务器精化完，
  避免拿到上一次的状态；
- 参数 schema 是**原始 JSON Schema**（`additionalProperties: false`），
  多传字段会被 DSH 的参数校验拒掉。

## 构建

### 产物

| 产物 | 大小 | 内容 |
| --- | --- | --- |
| `work/tmp/cm.js` | 389 KB | `@codemirror/*` 子集 IIFE（含折叠） |
| `work/tmp/infoview.js` | 2.5 MB | `@leanprover/infoview` 0.14.0 + React 18 |
| `work/tmp/infoview-css.js` | 284 KB | infoview 的 CSS（codicon 字体已转 data URI） |
| `work/tmp/katex.js` | 273 KB | KaTeX 的 JS（不含 CSS/字体） |
| `lib/client.js` | 3.66 MB | 浏览器半：vendor + 自有源码内联 |
| `lib/index.js` | 99 KB | 宿主半：`src/host/*` 内联，只 import `node:` |

构建是**确定性**的：`devDependencies` 全部钉死到精确版本（见 `package.json` 与
`package-lock.json`），同样的源码 + 同一套依赖产出逐字节一致的文件（可以用
`md5sum lib/*.js` 对比两次构建验证）。升级依赖版本会改变产物字节，这属于预期。

`lib/` 是构建产物、**不入库**（见 `.gitignore`），但 `package.json` 的 `files` 显式列了它，
所以 npm 打包仍然会带；`prepack` 会在 `npm pack` / `npm publish` 前重跑
`build-client` + `build-host`，保证 tarball 里的 `lib/` 是最新的。

**`git clone` 之后直接 `dsh plugin add <仓库目录>` 是不行的**——`main` 指向的 `lib/index.js`
不存在。要么用 tarball，要么先构建。

### 构建前置

只需要 Node ≥ 20 和一次 `npm install`（`devDependencies` 里是 `rolldown`、`@codemirror/*`、
`@leanprover/infoview` + `react@18`、`katex`，全部钉到精确版本）：

```powershell
npm ci        # 或 npm install
```

构建脚本用 `tools/deps.mjs` 定位这些包：先看本包自己的 `node_modules`，再用 Node 的常规
解析（覆盖 workspace / hoisted 布局），最后才退回旧开发布局（`../../work/upstream/*`、
`../../work/infoview-build`）。所以外部克隆者不需要照抄任何目录布局。

`build-infoview.mjs` 会临时把入口写进「装着 `@leanprover/infoview` 的那个 `node_modules`」
再删掉——rolldown 按入口所在目录向上解析，这样两种布局都能把 React 18 一起打进 bundle。
它还有一条守卫：bundle 小于 200 KB 就报错（依赖没解析上时 rolldown 会安静地打出一个空壳）。

### 命令

```powershell
npm run build              # 全部：codemirror → katex → infoview → client → host
npm run build:codemirror   # → work/tmp/cm.js
npm run build:katex        # → work/tmp/katex.js
npm run build:infoview     # → work/tmp/infoview.js + infoview-css.js
npm run build:client       # → lib/client.js
npm run build:host         # → lib/index.js
npm run check              # 对 src/ tools/ test/ 每个文件跑 node --check
```

`build-host.mjs` 会**拒绝任何非 `node:` 的裸 import**：以 `link:` 装进 profile 的包解析不到
别人的依赖树，混进一份宿主运行时（比如 `@deepseek-ai/cordis`）会导致同一进程里两份 cordis、
整个应用起不来。这条门是防这个的。

## 测试

19 个测试文件、**336 项断言**，全部纯 Node（`node test/xxx.test.mjs`），不依赖 vitest。
其中 `client-bundle`、`host-tools`、`markdown-math` 三项要读构建产物，所以**先构建再测**：

```powershell
npm run build
npm run check
npm test
```

| 文件 | 项 | 覆盖 |
| --- | --- | --- |
| `lean-mode` | 15 | 分词标签序列 |
| `save` | 15 | 写接口 URL 与响应信封翻译 |
| `conversation` | 11 | 草稿追加、chip 折叠偏移、选区围栏格式 |
| `lean-comments` | 22 | 注释扫描（嵌套块注释、字符串/字符字面量跳过）、可渲染区间 |
| `gutter-marks` | 14 | 对勾行号集合、处理中区间裁剪、两路合并、图标几何 |
| `markdown-lite` | 22 | 标题/列表/代码块/表格/转义 |
| `markdown-math` | 20 | 行内/块级公式、哨兵、坏公式降级、无 KaTeX 时退原文 |
| `doc-markdown` | 11 | 真 CodeMirror state 下的块装饰（光标进出、开关、重算、高度估值） |
| `folding` | 12 | 区间归一化、证明段识别、真 state 下 `foldable()` |
| `code-actions` | 15 | 建议排序、按路径筛编辑、按行筛诊断 |
| `navigation` | 14 | 路径压缩、行列 1 基换算、本文件/外部切分、大纲筛选 |
| `paths` | 15 | 相对路径 → 绝对路径、会话 cwd 取法、跨平台分隔符 |
| `infoview-config` | 21 | 13 项默认值、脏数据兜底、localStorage 读写、合并与短路 |
| `lsp` | 37 | URI 编码、位置换算、诊断映射、客户端管道、marker 过滤、rpcCode 透传 |
| `lean-binary` | 10 | toolchain 解析顺序（elan 壳慢 40 倍的根因） |
| `host-tools` | 20 | 9 个工具的 schema/契约/渲染、1 基换算、产物里的注册管线 |
| `infoview` | 36 | `EditorApi` 的 14 个方法、RPC 会话、事件口、版本守卫、样式注入 |
| `editor-surface` | 5 | 深/浅底判定（选区与 tooltip 配色） |
| `client-bundle` | 21 | 产物在假浏览器里求值 + descriptor 契约 + 状态效果走 `.of()` + KaTeX 只打包 JS |

`client-bundle` 会真的把 `lib/client.js` 丢进一个只有 `window` / `document` 的 vm 上下文里执行，
所以它能抓住「bundle 语法没问题但一加载就炸」这类错误。

### 真机探针

需要能 spawn `lean --server`（沙箱环境下要放宽权限）：

```powershell
node tools/probe-lsp.mjs            #  8 项：initialize / 诊断 / plainGoal / hover / completion / definition
node tools/probe-host-routes.mjs    #  9 项：用假 ctx 跑已构建的 lib/index.js，走真实 lean
node tools/probe-rpc-session.mjs    #  4 项：RPC 会话 30 s 超时、keepAlive 续命、改文件头部失效
node tools/probe-folding.mjs        # 14 项：foldingRange / documentSymbol / references / workspaceSymbol
node tools/probe-code-actions.mjs   #  8 项：exact? 的 Try this、扁平编辑列表、空区间不抛错
node tools/probe-cordis.mjs         # 14 项：真 cordis + 真 Lean：路由、SSE、9 个工具的 schema 与执行
```

`probe-layout` 与 `probe-math` 用无头 Edge 量真布局（jsdom 没有布局，rect 全是 0，
测不出错位，也测不出公式是否真排出了字形）；它们在 `work/` 下，不随包发布。

## 发布

`lib/` 不入库，发布前由 `prepack` 自动重建（`npm pack` / `npm publish` 都会先跑它）：

```powershell
npm pack                # → dsh-lean4-<version>.tgz（含 lib/、src/、tools/、两份 LICENSE）
npm pack --dry-run      # 只列内容、不落盘
```

版本号与 `CHANGELOG.md` 由人工维护，流程是：

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部补一节；
2. `npm ci && npm run build && npm run check && npm test` 全绿；
3. `git tag v<version>` 并推送；
4. `npm pack` 出的 tarball 可以直接给用户安装：
   `dsh plugin --profile desktop add "<绝对路径>/dsh-lean4-<version>.tgz"`。

CI（`.github/workflows/ci.yml`）在 Ubuntu 与 Windows、Node 20 与 22 上各跑一遍
`npm ci → build → check → test`，另有一条独立任务断言 tarball 里确实带 `lib/client.js`、
`lib/index.js`、`src/` 与两份 LICENSE——防止 `files` 与 `.gitignore` 的组合被改坏。

## 故障排查

| 症状 | 多半是因为 | 怎么办 |
| --- | --- | --- |
| 打开 `.lean` 还是纯文本 | 插件没装进当前 profile / 装完没重启 | 查 profile 的 `dsh.profile.bundles` 里有 `dsh-lean4`；完全退出桌面端再启动 |
| 状态栏「Lean 未连接（Lean 服务返回了无法解析的响应（HTTP 405））」 | 宿主半 `apply` 失败，路由没注册 | 看宿主日志（见下）；常见原因是 cordis 的 `inject` 缺声明 |
| 状态栏「Lean 未连接（the Lean server exited …）」 | 工程根不存在 / `lean` 起不来；连续失败已熔断 | 看宿主日志里的 `exited code=… stderr=…`；修好后点「重启」清掉熔断计数 |
| 第一次打开要等几十秒 | 走的是 PATH 上的 `lean`（elan 壳，联网查 release） | 在工程里放一份 `lean-toolchain`，或确认 elan 的 `default_toolchain` 已设好。插件会自动优先用 toolchain 里的真二进制 |
| infoview 一直显示 `Waiting for Lean server to start...` | 服务器还没 ready，或光标位置还没上报 | 等首包诊断；把光标放到文件里动一下；点「重启」 |
| infoview 报 `Outdated RPC session. Try again.` | RPC 会话被服务器作废 | 已由 10 s keepAlive + 数字错误码透传修掉；仍出现就点「重启」 |
| 注释卡片与行号错位 | widget 的垂直 margin 被高度图漏算 | 已在样式层改成 padding 并给 `estimatedHeight`；如仍偏，报 issue 附浏览器版本 |
| 选中一片区域字看不清 | CodeMirror 把深色底当成浅色主题 | 主题按挂载点文字色自动判 dark；异常时检查父级颜色变量 |
| Agent 调 `/lean-lsp/api` 得到 403 | 该路由只放行浏览器会话 | 用 9 个 Agent 工具，不要自己发 HTTP |

宿主半会把生命周期写进 `../../work/logs/lean-host.log`（相对包目录；写不进去就静默跳过）：
`apply`、服务器 spawn/dispose、退出码与 stderr 尾巴、工具注册结果都在里面。

## 已知限制与路线图

**没移植的**（vscode-lean4 的其余档位）：`\alpha` 缩写输入、Loogle 搜索面板、
module hierarchy 树、`.lean4markdown` 语言、`lakefile.toml` 校验，
以及要跑外部 CLI 的 Server / Setup / Project / Docs 命令。

**不会做的**：

- **折叠靠客户端猜证明**。Lean 的 `FoldingRangeKind` 只有 `comment` / `imports` / `region`
  三种（`Lean/Data/Lsp/LanguageFeatures.lean`，源码里根本没有 `"proof"` 这个字符串），
  上游那句 `isProof = kind === 'proof'` 在真机上永远为假。所以「折叠所有证明」按行首关键字
  （`theorem` / `lemma` / `example`，允许属性与 `private`/`noncomputable` 等前缀）自己挑。
- **infoview 的 `#html` widget 要 CDN**（`es-module-shims` + import map）。离线或被代理拦截时
  会渲染成空白，不影响目标/消息这些主要部分。
- **只有 `.lean`**。加别的后缀是改 `src/client-body.js` 里的 `EXTENSIONS`；
  再加一门语言要写第二个分词器。
- **分词器不做解析**：不写全套 Lean 符号表、不认属性载荷。不认识的符号不上色，
  比猜一个颜色诚实。

## 目录结构

```
src/lean-mode.js       StreamLanguage 分词器（纯函数，零依赖）
src/save.js            写接口 URL 拼装 + 响应信封翻译（纯函数）
src/conversation.js    选区 → 对话草稿（chip 折叠偏移、围栏格式化）
src/paths.js           相对路径 → 绝对路径（会话 cwd / 跨平台分隔符）
src/lean-comments.js   文档注释扫描 + 可渲染区间判定
src/doc-markdown.js    注释 → block 装饰 + markdown widget
src/markdown-lite.js   零依赖 markdown 渲染器（含 KaTeX 公式）
src/gutter-marks.js    gutter 标记：完成对勾 / 处理中圆盘
src/third-party/goals-accomplished-icon.js  对勾 SVG（Apache-2.0，单独成文件）
src/folding.js         foldingRange 归一化、证明段识别、foldService 接线
src/code-actions.js    Try this 的排序、按路径筛编辑、按行筛诊断
src/navigation.js      跳转位置格式化（对外 1 基）、大纲与筛选
src/infoview-config.js infoview 13 项配置的默认值、校验、持久化
src/lean-lsp.js        LSP 客户端（fetch / EventSource 可注入）
src/infoview.js        官方 infoview 的 EditorApi 桥
src/lsp-extensions.js  位置换算 / 诊断映射 / 悬停渲染 / attachLsp
src/editor.js          CodeMirror 装配（主题 / HighlightStyle / 快捷键 / revealLine）
src/style.js           --dle-* 变量 → --shiki-token-*，编辑器与面板样式
src/client-body.js     cordis 插件与 React 组件（注册、保存、状态、面板）
src/host/lsp-framing.js    LSP 报文编解码（Content-Length 用 UTF-8 字节数）
src/host/lean-binary.js    绕开 elan 壳，从 toolchain 目录直接找 lean 本体
src/host/lean-server.js    一个 lean --server 子进程的生命周期与请求封装
src/host/hostlog.js        宿主侧日志（桌面端 console 不落地）
src/host/tools.js          9 个 Agent 工具的定义（纯函数，零 import）
src/host/plugin.js         路由、服务器池、SSE 广播、工具注册
lib/client.js          构建产物：浏览器半（不入库）
lib/index.js           构建产物：宿主半，只 import node:（不入库）
tools/deps.mjs         依赖定位（本包 node_modules → Node 解析 → 旧开发布局）
tools/build-*.mjs      六条构建流水线（codemirror / katex / infoview / client / host）
tools/codemirror-entry.js  rolldown 打 CodeMirror 的入口（按包分组 export）
tools/infoview-entry.js    rolldown 打 infoview 的入口
tools/check-syntax.mjs     node --check 全量语法检查
tools/probe-*.mjs      真机探针（需要本机有 Lean）
test/*.test.mjs        单元测试（19 个文件 / 336 项）
test/fixtures/         测试用的 Lean 样本
.github/workflows/ci.yml  Ubuntu + Windows × Node 20/22
CHANGELOG.md           版本历史
```

构建产物与 vendor 中间产物（`lib/`、`work/`）都不入库；`.gitignore` 忽略它们，
但 `package.json` 的 `files` 显式列了 `lib`，所以发布出去的 tarball 仍然带着产物。

## 许可

- 本插件自有源码：**MPL-2.0**（[LICENSE](./LICENSE)）。它是**逐文件**的 copyleft：
  改本插件的人要把改动以 MPL-2.0 回馈，但把插件装进更大的产品不会波及那个产品的其余部分。
- 含两份上游 [leanprover/vscode-lean4](https://github.com/leanprover/vscode-lean4) 的
  **Apache-2.0** 内容：对勾 SVG 的 path 数据、以依赖形式打包的 `@leanprover/infoview`。
  为避免协议冲突，SVG 素材**单独成文件** `src/third-party/goals-accomplished-icon.js`
  （文件头标 `Apache-2.0`），不并进 MPL-2.0 的源码；Apache 全文另存
  [LICENSE-APACHE-2.0](./LICENSE-APACHE-2.0)。
- 打包进 bundle 的第三方：CodeMirror 系列与 KaTeX 是 MIT，`@leanprover/infoview` 是 Apache-2.0。
- 每个自有源文件头都有 `SPDX-License-Identifier: MPL-2.0`；`lib/` 是聚合了多种许可组件的
  构建产物。逐项归属见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

### 沿革

本包在内部开发期间叫 `dsh-lean-editor`，公开发布前改名 `dsh-lean4`（bundle id、
cordis 插件名、localStorage 键一并改；老的 infoview 配置会从旧键自动迁移）。
`VIEWER_ID` 仍是 `lean-editor:lean`，以免重置大家的 `viewersEnabled` 偏好。

### 致谢

[leanprover/vscode-lean4](https://github.com/leanprover/vscode-lean4)（功能参照与 SVG 素材、infoview）、
[DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（承载编辑器的侧边栏）、
[Lean 4](https://lean-lang.org)、[CodeMirror](https://codemirror.net)、[KaTeX](https://katex.org)。
