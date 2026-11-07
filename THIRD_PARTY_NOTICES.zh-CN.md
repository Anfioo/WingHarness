# 第三方声明

WingHarness — 版权所有 (C) 2026 Anfioo

WingHarness 以 GNU 通用公共许可证第 3 版（仅此版本，GPL-3.0-only）发布，见
[LICENSE](./LICENSE)。本文件记录随程序一同分发的第三方作品，以及各部分各自保留的
条款。它不改变本项目自身代码的许可证。

本文件是 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 的中文译本；两者如有
出入，以英文版为准。

上游项目的完整清单——包括代码**没有**进入本仓库的那些——见
[docs/UPSTREAM_PROJECTS.zh-CN.md](./docs/UPSTREAM_PROJECTS.zh-CN.md)。

---

## 1. 来源项目

### angkorgit

- 项目：[angkorgit](https://github.com/cheat2001/angkorgit)
- 许可证：MIT
- 许可证文本：[licenses/AngKorGit-LICENSE.txt](./licenses/AngKorGit-LICENSE.txt)

`src-tauri/git-core`（Git 仓库窗口的引擎）改编自 angkorgit。导入时有 16 个文件
逐字节一致；该 crate 现在由本仓库作为自有代码维护。

### cc-switch

- 项目：[cc-switch](https://github.com/farion1231/cc-switch)
- 许可证：MIT
- 许可证文本：[licenses/cc-switch-LICENSE.txt](./licenses/cc-switch-LICENSE.txt)

`src-tauri/src/ccs` 与 CC Switch 页面实现了相同的供应商模型，并读取 cc-switch 的
SQLite 数据库（`~/.cc-switch/cc-switch.db`）。`hermes.png` 图标复制自上游项目。

### desktop-cc-gui

- 项目：[desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui)（`ccgui-next`）
- 版本：1.2.2
- 许可证：MIT
- 许可证文本：[licenses/desktop-cc-gui-LICENSE.txt](./licenses/desktop-cc-gui-LICENSE.txt)
- 版权：2026 zhukunpenglinyutong（朱昆鹏）

`src-tauri/agent-chat-core` 的一部分——引擎传输层、Claude、Codex 与 ACP 适配器、
批量事件出口，以及 Claude/Codex 原生会话扫描——改编自 desktop-cc-gui。对话页面
按本仓库的组件体系重写。移植记录见
`src-tauri/agent-chat-core/UPSTREAM.md`。

### Frpilot

- 项目：[Frpilot](https://github.com/leapfu/frpilot)
- 版本：1.0.0
- 许可证：MIT
- 许可证文本：[licenses/Frpilot-LICENSE.txt](./licenses/Frpilot-LICENSE.txt)

Copyright (c) leapfu。frpc 进程管理、TOML 生成、运行时发现与日志处理的一部分改编
自 Frpilot。上游的 SQLite 持久化、keyring 凭据存储与官方运行时下载器未移植。

### jetbrains-cc-gui

- 项目：[jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)
- 许可证：MIT
- 许可证文本：[licenses/jetbrains-cc-gui-LICENSE.txt](./licenses/jetbrains-cc-gui-LICENSE.txt)

Claude 聊天页与 `src-tauri/src/commands/claude_history.rs` 是 jetbrains-cc-gui 的
行为移植；复制了一个通用辅助文件（`cn.ts`）。

### MangoDisk

- 项目：[MangoDisk](https://github.com/harry0703/MangoDisk)
- 版本：1.2.2
- 许可证：GPL-3.0-only
- 许可证文本：[LICENSE](./LICENSE)
- 版权：MangoDisk 贡献者。

系统工具模块（`src-tauri/systools-core` 与 systools 页面）派生自 MangoDisk：
磁盘分析、重复文件、大文件、启动项、应用卸载 / 残留清理与系统设置。导入时有
10 个文件逐字节一致。这些部分以 GPL-3.0-only 分发；完整许可证文本见
[LICENSE](./LICENSE)。移植的子系统仅支持 Windows；未携带 macOS 与 Linux 代码。

### McpHub

- 项目：[McpHub](https://github.com/Soflutionltd/McpHub)
- 许可证：MIT
- 许可证文本：[licenses/McpHub-LICENSE.txt](./licenses/McpHub-LICENSE.txt)

`src-tauri/src/mcphub` 改编自 McpHub；每个源文件都保留了归属声明。

### openidea

- 项目：[openidea](https://github.com/l0ng-ai/openidea)
- 版本：0.1.37
- 许可证：Apache-2.0
- 许可证文本：[licenses/Apache-2.0.txt](./licenses/Apache-2.0.txt)

数据库功能的一部分——SQL 词法分析、方言、分析、补全、格式化、DDL 生成、结果表格与
导出辅助——改编自 openidea。Copyright (c) the openidea authors，按 Apache License,
Version 2.0 授权。

`src-tauri/db-core` 与数据库页面移植自 openidea 的 `crates/ide-db`：数据源、连接、
元数据浏览、多语句查询执行、表分页与行编辑、DDL 生成与补全。SSH 隧道、SQL Server、
ClickHouse 与 Oracle 分支、`specta` 类型生成以及 keychain 密码存储未移植。移植记录见
`src-tauri/db-core/UPSTREAM.md` 与 `src/pages/database/UPSTREAM.md`。

### OrcaSVN

- 项目：[OrcaSVN](https://github.com/wustites/OrcaSVN)
- 许可证：MIT
- 许可证文本：[licenses/OrcaSVN-LICENSE.txt](./licenses/OrcaSVN-LICENSE.txt)

`src-tauri/svn-core` 与 SVN 工作区页面整体移植自 OrcaSVN，`svn-core/src/lib.rs`
中有说明。

### shaic

- 项目：[shaic](https://github.com/dariocurr/shaic)
- 版本：v0.3.0
- 许可证：MIT
- 许可证文本：[licenses/shaic-LICENSE.txt](./licenses/shaic-LICENSE.txt)

`src-tauri/shaic-core` 派生自 shaic 的 `core/` crate；导入时有 51 个文件逐字节
一致。该 crate 现在是自有引擎并在本仓库中修改。移植记录见
`src-tauri/shaic-core/UPSTREAM.md`。

### TizuMark

- 项目：[TizuMark](https://github.com/tizuio/TizuMark-Markdown-Editor)
- 许可证：GPL-3.0-only
- 许可证文本：[LICENSE](./LICENSE)
- 版权：TizuMark 贡献者。

Markdown 编辑器模块（`src-tauri/md-editor-core` 与 md-editor 页面）移植自
TizuMark。其原生 PDF 导出（WebView2 `PrintToPdf`，基于 `webview2-com` /
`windows`）、大纲提取与导出方案都是实质性移植，仍适用 GPL-3.0-only。前端是面向
React 19 与 CodeMirror 6 的重写，不是 TizuMark 实现的复制。

### tweakcn

- 项目：[tweakcn](https://tweakcn.com) — [jnsahaj/tweakcn](https://github.com/jnsahaj/tweakcn)
- 许可证：Apache-2.0
- 许可证文本：[licenses/tweakcn-LICENSE.txt](./licenses/tweakcn-LICENSE.txt)

`src/lib/theme/presets.json` 是 tweakcn 公开主题的快照，由
`scripts/fetch-theme-presets.mjs`（`pnpm themes:fetch`）生成。该文件只含颜色令牌
数据，不含上游源代码。

### use-claude

- 项目：[use-claude](https://github.com/ekaone/use-claude)
- 许可证：MIT
- 许可证文本：[licenses/use-claude-LICENSE.txt](./licenses/use-claude-LICENSE.txt)

`src/lib/use-claude` 内联自 `@ekaone/use-claude` 包；文件头保留了归属声明。

### XTerm

- 项目：[XTerm](https://github.com/Rockytkg/XTerm)
- 版本：1.0.6
- 许可证：MIT
- 许可证文本：[licenses/XTerm-LICENSE.txt](./licenses/XTerm-LICENSE.txt)

服务器管理模块（`src-tauri/server-core`）的 SSH / SFTP 后端是精简重写，沿用了
XTerm 的 `russh` / `russh-sftp` 用法、主机密钥指纹（`ring` SHA-256、无填充
base64、`SHA256:` 前缀）与连接超时。未复制其 Vue 前端；本应用界面为 React。

---

## 2. 随附的库

下表列出随构建产物一起分发的**直接依赖**。确切版本由 `pnpm-lock.yaml` 与
`src-tauri/Cargo.lock` 锁定。传递依赖由同样的两个锁文件解析；其中许可证并非宽松
许可的包，在 Rust 表之后单独列出。每个依赖都在自己的 `node_modules` 目录或 crate
源码中附带许可证文本。

### JavaScript / TypeScript

| 包 | 许可证 |
|----|--------|
| `7z-wasm` | LGPL + unRAR 限制 —— 见 §3 |
| `@codemirror/commands` | MIT |
| `@codemirror/lang-markdown` | MIT |
| `@codemirror/language` | MIT |
| `@codemirror/search` | MIT |
| `@codemirror/state` | MIT |
| `@codemirror/view` | MIT |
| `@dnd-kit/core` | MIT |
| `@dnd-kit/sortable` | MIT |
| `@dnd-kit/utilities` | MIT |
| `@lezer/highlight` | MIT |
| `@mind-elixir/import-xmind` | MIT |
| `@streamdown/cjk` | Apache-2.0 |
| `@streamdown/code` | Apache-2.0 |
| `@streamdown/math` | Apache-2.0 |
| `@streamdown/mermaid` | Apache-2.0 |
| `@tailwindcss/vite` | MIT |
| `@tanstack/react-virtual` | MIT |
| `@tauri-apps/api` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-dialog` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-global-shortcut` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-opener` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-process` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-updater` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-window-state` | MIT OR Apache-2.0 |
| `@xterm/addon-fit` | MIT |
| `@xterm/xterm` | MIT |
| `ag-psd` | MIT |
| `cfb` | Apache-2.0 |
| `chart.js` | MIT |
| `class-variance-authority` | Apache-2.0 |
| `clsx` | MIT |
| `cmdk` | MIT |
| `cn` | MIT |
| `codelet` | MIT |
| `dompurify` | MPL-2.0 OR Apache-2.0 |
| `exceljs` | MIT |
| `fflate` | MIT |
| `highlight.js` | BSD-3-Clause |
| `i18next` | MIT |
| `i18next-browser-languagedetector` | MIT |
| `icojs` | MIT |
| `jszip` | MIT OR GPL-3.0-or-later |
| `katex` | MIT |
| `lucide-react` | ISC |
| `mammoth` | BSD-2-Clause |
| `marked` | MIT |
| `mermaid` | MIT |
| `mind-elixir` | MIT |
| `node-unrar-js` | MIT |
| `papaparse` | MIT |
| `pdfjs-dist` | Apache-2.0 |
| `postal-mime` | MIT-0 |
| `pptxviewjs` | MIT |
| `radix-ui` | MIT |
| `react`、`react-dom` | MIT |
| `react-day-picker` | MIT |
| `react-i18next` | MIT |
| `react-resizable-panels` | MIT |
| `sonner` | MIT |
| `streamdown` | Apache-2.0 |
| `tailwind-merge` | MIT |
| `tailwindcss` | MIT |
| `utif` | MIT |
| `yaml` | ISC |
| `zustand` | MIT |

### Rust

| crate | 许可证 |
|-------|--------|
| `async-trait` | MIT OR Apache-2.0 |
| `base64` | MIT OR Apache-2.0 |
| `blake3` | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception |
| `bytes` | MIT |
| `chrono` | MIT OR Apache-2.0 |
| `clap` | MIT OR Apache-2.0 |
| `clash-prism-extension` | Apache-2.0 |
| `dirs` | MIT OR Apache-2.0 |
| `encoding_rs` | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| `font-kit` | MIT OR Apache-2.0 |
| `fontdb` | MIT |
| `fs2` | MIT OR Apache-2.0 |
| `futures-util` | MIT OR Apache-2.0 |
| `getrandom` | MIT OR Apache-2.0 |
| `git2` | MIT OR Apache-2.0 |
| `hex` | MIT OR Apache-2.0 |
| `indexmap` | Apache-2.0 OR MIT |
| `keyring` | MIT OR Apache-2.0 |
| `log` | MIT OR Apache-2.0 |
| `notify-debouncer-mini` | MIT OR Apache-2.0 |
| `once_cell` | MIT OR Apache-2.0 |
| `png` | MIT OR Apache-2.0 |
| `portable-pty` | MIT |
| `quick-xml` | MIT |
| `regex` | MIT OR Apache-2.0 |
| `reqwest` | MIT OR Apache-2.0 |
| `ring` | Apache-2.0 AND ISC |
| `rusqlite` | MIT |
| `russh` | Apache-2.0 |
| `russh-sftp` | Apache-2.0 |
| `serde`、`serde_json` | MIT OR Apache-2.0 |
| `serde_yaml_ng` | MIT |
| `serde_yml` | MIT OR Apache-2.0 |
| `sha2` | MIT OR Apache-2.0 |
| `tauri` | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | Apache-2.0 OR MIT |
| `tauri-plugin-global-shortcut` | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | Apache-2.0 OR MIT |
| `tauri-plugin-process` | Apache-2.0 OR MIT |
| `tauri-plugin-single-instance` | Apache-2.0 OR MIT |
| `tauri-plugin-updater` | Apache-2.0 OR MIT |
| `tauri-plugin-window-state` | Apache-2.0 OR MIT |
| `tempfile` | MIT OR Apache-2.0 |
| `thiserror` | MIT OR Apache-2.0 |
| `tokio` | MIT |
| `tokio-util` | MIT |
| `toml` | MIT OR Apache-2.0 |
| `toml_edit` | MIT OR Apache-2.0 |
| `url` | MIT OR Apache-2.0 |
| `uuid` | Apache-2.0 OR MIT |
| `walkdir` | Unlicense OR MIT |
| `webview2-com` | MIT |
| `which` | MIT |
| `windows` | MIT OR Apache-2.0 |
| `windows-core` | MIT OR Apache-2.0 |
| `windows-sys` | MIT OR Apache-2.0 |
| `winreg` | MIT |
| `zip` | MIT |

`tauri-build` 是构建期依赖，不随产物分发。

### 需要单独说明的传递依赖

两个锁文件解析出约 500 个 JavaScript 包与 850 个 Rust 包。绝大多数采用 MIT、
Apache-2.0、BSD、ISC 或其兼容组合。例外如下：

| 包 | 许可证 | 引入路径 | 说明 |
|----|--------|----------|------|
| `elkjs` | EPL-2.0 | `mermaid` | 会进入 JavaScript 产物。EPL-2.0 不在移植门槛的允许清单内，因此这是一项待办：确认所发布构建适用 EPL-2.0 的次级许可证条款，或不再打包 ELK 布局。 |
| `lightningcss`、`lightningcss-win32-x64-msvc` | MPL-2.0 | `@tailwindcss/vite`、`vite` | 仅构建期使用，不随应用分发。 |
| `buffers` | 未声明 | `exceljs` → `unzipper` → `binary` | 该包既没有 `license` 字段，也没有许可证文件。需要确认其代码是否进入 Excel 查看器产物；若进入，应替换或取得许可。 |

MPL-2.0 是文件级著佐权，与 GPL-3.0-only 兼容；上述 MPL-2.0 组件是构建工具，不随
产物分发。Apache-2.0 全文见
[licenses/Apache-2.0.txt](./licenses/Apache-2.0.txt)。

上面这些 MIT、BSD、ISC、Apache-2.0、MPL-2.0 与 LGPL 组件与 GPL-3.0-only 兼容：
组合作品以 GPL-3.0-only 分发，各库保留自己的条款。`7z-wasm` 单独适用 §3 的声明，
分发时必须一并附上。

---

## 3. 7-Zip 声明

`7z-wasm`（`https://github.com/use-strict/7z-wasm`）内嵌了 7-Zip。其许可证要求在
分发时附带本声明：

> 7-Zip Copyright (C) 1999-2015 Igor Pavlov.
>
> Licenses for files are:
>
> 1. `7zz.*.js`, `7zz.wasm`: GNU LGPL + unRAR restriction
> 2. All other files: GNU LGPL
>
> The GNU LGPL + unRAR restriction means that you must follow both GNU LGPL
> rules and unRAR restriction rules.

unRAR 限制的含义是：该源码可以无限制地用于处理 RAR 压缩包，但**不得用于开发与
RAR 兼容的压缩工具**；不得用 RAR 压缩器或 unRAR 重建 RAR 压缩算法。

7-Zip 声明与 unRAR 限制的文本见：

- [licenses/7z-wasm-License.txt](./licenses/7z-wasm-License.txt)
- [licenses/7z-wasm-unRarLicense.txt](./licenses/7z-wasm-unRarLicense.txt)

其中引用的 GNU 宽通用公共许可证（LGPL）全文见
[licenses/LGPL-2.1.txt](./licenses/LGPL-2.1.txt)。

`node-unrar-js` 使用 MIT 许可证，不带单独的 unRAR 限制。

---

## 4. 报告遗漏

如果你认为某个作品被分发却没有附带它要求的声明，请到
https://github.com/Anfioo/WingHarness/issues 提 issue —— 见
[CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)。
