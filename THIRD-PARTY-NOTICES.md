# 许可与第三方代码

本仓库（`dsh-lean4`）以 **Mozilla Public License 2.0（MPL-2.0）** 发布，全文见
[LICENSE](./LICENSE)。MPL-2.0 是**逐文件**的 copyleft：它覆盖本项目自己写的源文件，
不覆盖下面列出的第三方组件——那些组件各自保留自己的许可，随包分发时各按各的条款执行。

分发形态有两种，覆盖范围不同：

| 形态 | 覆盖 |
| --- | --- |
| `src/`、`tools/`、`test/` 下的自有文件 | MPL-2.0（每个文件头有 `SPDX-License-Identifier: MPL-2.0`） |
| `lib/client.js`、`lib/index.js` | **构建产物**，聚合了多种许可的组件；不是单一许可的作品 |

`lib/index.js` 只内联本项目自有源码（MPL-2.0）。`lib/client.js` 则把 MPL-2.0 的自有代码、
Apache-2.0 的素材与依赖、MIT 的 CodeMirror 与 KaTeX 拼进同一个文件——按 MPL-2.0 §1.7
（Larger Work）与 §3.3 这是允许的，只要各组件的许可条款仍然对各自的代码成立。构建脚本
会在产物头部写明这一点。

## 一、Apache-2.0 内容（来自 vscode-lean4）

上游 [leanprover/vscode-lean4](https://github.com/leanprover/vscode-lean4)，
Copyright the Lean Prover Community，许可为 Apache License 2.0，全文原样收在
[LICENSE-APACHE-2.0](./LICENSE-APACHE-2.0)。上游没有单独的 NOTICE 文件，归属记在此处。

本项目包含两部分该许可下的内容，**都与 MPL-2.0 的源码分文件隔离**，这样两种条款各自成立：

### 1. 对勾图标素材 → `src/third-party/goals-accomplished-icon.js`

| 内容 | 来源 |
| --- | --- |
| `CHECK_BODY` / `CHECK_DETAIL` 两段 SVG path 与 `transform="translate(-0.4018449,-0.16325205)"` | `vscode-lean4/media/diagnostic-gutter-icons/goals-accomplished-checkmark-dark.svg` |

这个文件头写的是 `SPDX-License-Identifier: Apache-2.0`，**不受本项目 MPL-2.0 覆盖**。
`src/gutter-marks.js`（MPL-2.0）只是 `import` 它，不含它的内容——这正是分文件的原因：
把 Apache-2.0 的素材并进 MPL-2.0 的文件里，就没法同时满足两边的条款。

### 2. `@leanprover/infoview` 0.14.0（未修改的 dist）

与该仓库同源（`lean4-infoview/`），以依赖形式原样打进 `lib/client.js`，未做修改。

## 二、MIT 内容（打包进 `lib/client.js`）

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| `@codemirror/state` | 6.7.6 | 编辑器状态 |
| `@codemirror/view` | 6.43.15 | 编辑器视图 |
| `@codemirror/language` | 6.13.1 | 折叠、语法树 |
| `@codemirror/commands` | 6.11.1 | 基础命令 |
| `@codemirror/autocomplete` | 6.20.4 | 补全 |
| `@codemirror/search` | 6.7.2 | 搜索 |
| `@codemirror/lint` | 6.9.7 | 诊断波浪线 |
| `katex` | 0.16.47 | 注释里的 LaTeX 公式（只打包 JS；CSS 与字体来自 DSH 宿主页面） |

## 二之二、构建期依赖（不进产物）

这些只在构建机上跑，不会被打进 `lib/`，但发布源码时它们是复现构建的前提：

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `rolldown` | 1.2.16 | MIT | 把 CodeMirror / infoview 打成 IIFE |
| `react` / `react-dom` | 18.3.1 | MIT | 与 `@leanprover/infoview` 一起打进 `lib/client.js`（infoview 的 React 运行时） |

## 三、参照上游实现、但没有复制代码的部分

下面这些是「读了 `vscode-lean4` 的源码，理解了协议/判据，然后自己重写」，不含上游代码，
因此按本项目的 MPL-2.0 授权：

- `@leanprover/infoview` 的 `InfoviewConfig` 13 个字段名与默认值（`src/infoview-config.js`
  与 `dist/index.production.min.js` 的 `defaultInfoviewConfig` 逐字段一致）；
- RPC keepAlive 10 秒（上游 `src/infoview.ts` 的 `keepAlivePeriodMs`）；
- `leanTags: [2]`（GoalsAccomplished）标记证明完成、`isSilent` 只做装饰；
- `textDocument/foldingRange`、`codeAction`、`references` 等方法的使用方式；
- 「Lean 从不发 `kind: 'proof'`」这一事实的验证结论（与上游的判断相反：它的 `isProof`
  从未生效，我们改用行首关键字挑证明）。

## 四、没有使用

- 上游的 TypeScript 源码（`vscode-lean4/src/*.ts`）：**一个文件都没有复制**；
- TextMate 语法 `syntaxes/lean4.json`：分词器是 `src/lean-mode.js` 自己写的；
- `lean4-unicode-input/src/abbreviations.json`（`\alpha` 缩写表）：尚未接入。

## 五、为什么是 MPL-2.0 而不是 Apache-2.0

MPL-2.0 对**文件**做 copyleft：改动本项目源码的人需要把改动以 MPL-2.0 回馈，但把本插件
装进更大的产品（例如 DSH 或别的宿主）不会波及那个产品的其余部分——这正是插件想要的边界。
Apache-2.0 的内容按 §1.7 Larger Work 与 MPL-2.0 共存，前提就是像上面那样分文件、各自声明。

## 六、源码可得性（MPL-2.0 §3.2(a)）

分发 `lib/` 里的构建产物时，对应源码必须在同一处可得。因此 `package.json` 的 `files`
里带着 `src/`（自有源码），构建脚本在 `tools/`，测试在 `test/`——都在同一个包里。
