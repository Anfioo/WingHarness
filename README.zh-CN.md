<div align="center">

<img src="./assets/logo.svg" width="120" height="120" alt="WingHarness logo" />

# WingHarness

[English](./README.md) | 简体中文

[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-GPLv3-blue)](./LICENSE)

一个 Tauri v2 桌面应用模板：外壳与原生部分已经接好，写下的第一段代码就是功能，
而不是窗口边框。

</div>

## 模板里有什么

比 `create-tauri-app` 给的多，但没有一样属于某个具体产品：

- **无边框窗口 + 自绘标题栏** —— 拖拽、最小化、最大化、关闭，以及窗口右键菜单，落在透明圆角窗口上
- **应用内路由** —— 基于路径名，页面按需懒加载；属于独立窗口的路由自带外壳。切换页面只替换内容，侧边栏不会重载整份文档
- **浅色 / 深色 / 跟随系统主题，以及字体预设** —— 预设自带字体，首次使用时下载并缓存到本地
- **系统托盘** —— 图标、随主题的右键菜单，以及一个弹出窗口
- **全局快捷键** —— 注册到操作系统，可运行时修改，重启后保留
- **国际化** —— i18next，中英两种语言共用一套键，没有漏译
- **本地终端** —— 真正的伪终端（`portable-pty`），渲染在 webview 里
- **笔记** —— 存放在数据目录下的 Markdown 库，用内置的 codelet 编辑器编辑
- **项目文件浏览器** —— 按需逐层返回的目录树，被限制在单一根目录内
- **文件预览** —— Word、Excel、PowerPoint、PDF、图片、压缩包、电子书、PSD、XMind、音视频全部在 webview 里解析，纯文本可带编码选择编辑；还有独立预览窗口，在 Explorer、桌面或 Everything 里按空格即可打开
- **数据目录设置** —— 所有持久化数据都落在同一个可配置目录下
- **关于窗口与设置窗口** —— 各自是「第二个窗口 + 独立路由」的完整示例
- **自动更新** —— GitHub Actions 发布签名版本，由 Tauri updater 安装
- **TypeScript strict、ESLint、Prettier** —— 已配置，而不是让你自己配

## 技术栈

- **桌面框架**：[Tauri v2](https://tauri.app/)（Rust）
- **前端框架**：[React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **构建工具**：[Vite](https://vite.dev/)
- **UI 组件**：[shadcn/ui](https://ui.shadcn.com/)
- **样式**：[Tailwind CSS v4](https://tailwindcss.com/)
- **编辑器内核**：[codelet](https://www.npmjs.com/package/codelet) —— 编辑器是一个依赖，而不是一套框架
- **代码格式化**：[Prettier](https://prettier.io/) + [ESLint](https://eslint.org/)

## 开始使用

### 环境要求

- Node.js >= 18
- pnpm >= 9
- Rust >= 1.70

### 安装与运行

```bash
pnpm install
pnpm tauri dev      # Vite 开发服务器在 :11421，同时启动应用
```

### 构建生产版本

```bash
pnpm tauri build          # NSIS 安装包
pnpm tauri:build:ps       # 带签名的 NSIS + 更新产物（scripts/build.ps1）
```

### 全量检查

```bash
pnpm check          # prettier --check、eslint、tsc、vite build
```

## 项目结构

```
.
├── src/                      # 前端（React + TypeScript）
│   ├── main.tsx              # 入口：pageMap + standalonePaths
│   ├── pages/                # 主窗口页面：start、local-terminal、notes、file-preview、project；preview-window 是独立窗口
│   ├── windows/              # 独立窗口路由：about、settings、tray-menu
│   ├── components/           # 外壳、标题栏、侧边栏、文件预览、shadcn/ui 原语
│   ├── lib/                  # router、app-routes、editor、preview viewers、fonts、terminal、theme
│   ├── commands/             # Tauri 命令的类型化封装（一域一模块）
│   ├── hooks/                # 共享 React hooks
│   └── i18n/                 # i18next 配置与 locales/{en,zh}.json
├── src-tauri/                # 后端（Rust）
│   ├── src/                  # commands/、config/、fonts/、theme/、plugins/（托盘）
│   ├── file-preview/         # workspace crate：旧预览页的字节读取
│   ├── space-preview-core/   # workspace crate：预览读写、文本编码、Windows 空格代理
│   └── tauri.conf.json       # 窗口、打包与更新配置
├── docs/                     # 跨功能文档；功能文档在 features/ 下
└── scripts/                  # 版本发布、主题预设、build.ps1
```

## 页面与窗口

| 路由 | 文件 | 类型 |
|------|------|------|
| `/` | `pages/start/index.tsx` | 主窗口 |
| `/local-terminal` | `pages/local-terminal/index.tsx` | 主窗口 |
| `/notes` | `pages/notes/index.tsx` | 主窗口 |
| `/file-preview` | `pages/file-preview/index.tsx` | 主窗口 |
| `/preview-window` | `pages/preview-window/index.tsx` | 独立窗口 |
| `/project` | `pages/project/index.tsx` | 主窗口 |
| `/about` | `windows/about/index.tsx` | 独立窗口 |
| `/settings` | `windows/settings/index.tsx` | 独立窗口 |
| `/tray-menu` | `windows/tray-menu/index.tsx` | 独立窗口 |

主窗口页面由共享的 `AppShell` 包住；独立窗口路由写在 `standalonePaths` 里，自带
外壳。`/preview-window` 声明为隐藏，由预览的空格代理显示。

## 如何扩展

### 新增页面

1. 新建 `src/pages/<name>/index.tsx`，内容用 `<AppShell>` 包住
2. 在 `src/main.tsx` 的 `pageMap` 里加一条
3. 在 `src/lib/app-routes.ts` 的 `appRoutes` 里加一行（id、path、icon，以及标题等文案——
   这些是该文件里的字面字符串，不走 i18n）

### 新增 Tauri 命令

一条命令必须在四个地方登记，否则运行时会被 ACL 拒绝——见
[src-tauri/CLAUDE.md](./src-tauri/CLAUDE.md)。前两处不一致时 `build.rs` 会让构建失败。

### 新增 shadcn/ui 组件

```bash
pnpm dlx shadcn@latest add button
```

## 文档

每份文档都写两遍，英文与中文各一版（`X.md` / `X.zh-CN.md`）。跨功能的文档放在
`docs/` 根目录，只与某一个功能相关的放在 `docs/features/` 下。

| 文档 | 内容 |
|------|------|
| [docs/AUTO_UPDATE.md](./docs/AUTO_UPDATE.md) | 更新端点、签名密钥、GitHub Actions 发布流程 |
| [docs/GLOBAL_SHORTCUT.md](./docs/GLOBAL_SHORTCUT.md) | 向操作系统注册快捷键 |
| [docs/I18N.md](./docs/I18N.md) | i18next 配置与新增语言 |
| [docs/UPSTREAM_PROJECTS.zh-CN.md](./docs/UPSTREAM_PROJECTS.zh-CN.md) | 所有上游项目、各自的许可证，以及移植记录 |

### 功能文档

功能文档随功能一起加入；下面这些同时也是移植时依据的规格，因此有几篇描述的是本
仓库中尚未落地的页面。

| 文档 | 内容 |
|------|------|
| [AI_CONFIG.zh-CN.md](./docs/features/AI_CONFIG.zh-CN.md) | AI 配置同步：一个 git 仓库作为唯一来源，再翻译成各 agent 的目录布局 |
| [API_CLIENT.zh-CN.md](./docs/features/API_CLIENT.zh-CN.md) | 类 Postman 的 REST 客户端，由 OpenAPI 或 Swagger 文档驱动 |
| [CC_SWITCH.zh-CN.md](./docs/features/CC_SWITCH.zh-CN.md) | AI 编码 CLI 的供应商管理 |
| [CLAUDE_CODE.zh-CN.md](./docs/features/CLAUDE_CODE.zh-CN.md) | Claude 对话、历史与工作流三个页面 |
| [DATABASE.zh-CN.md](./docs/features/DATABASE.zh-CN.md) | 数据源、带页签的数据源窗口（查询文件与页签持久化）、SQL 控制台、执行计划、表数据与对象管理 |
| [FILE_PREVIEW.zh-CN.md](./docs/features/FILE_PREVIEW.zh-CN.md) | 预览引擎、独立空格窗口、文本编辑、支持的格式、如何新增一种格式 |
| [FRP.zh-CN.md](./docs/features/FRP.zh-CN.md) | FRP 控制台：生成 `frpc` 配置、子进程与日志 |
| [GIT.zh-CN.md](./docs/features/GIT.zh-CN.md) | 本地 Git 客户端，每个仓库一个窗口 |
| [MCP_HUB.zh-CN.md](./docs/features/MCP_HUB.zh-CN.md) | 用一个本地端点聚合本地 MCP 服务器 |
| [MD_EDITOR.zh-CN.md](./docs/features/MD_EDITOR.zh-CN.md) | 多标签 Markdown 编辑器，文件留在原处 |
| [NOTES.zh-CN.md](./docs/features/NOTES.zh-CN.md) | 存放在数据目录中的 Markdown 笔记 |
| [PLUGINS.zh-CN.md](./docs/features/PLUGINS.zh-CN.md) | 插件格式、清单文件，以及自动生成设置界面 |
| [PROJECT.zh-CN.md](./docs/features/PROJECT.zh-CN.md) | 项目文件浏览与编辑 |
| [SERVERS.zh-CN.md](./docs/features/SERVERS.zh-CN.md) | SSH / SFTP 服务器管理 |
| [SVN.zh-CN.md](./docs/features/SVN.zh-CN.md) | 原生 Subversion 工作副本 |
| [SYSTOOLS.zh-CN.md](./docs/features/SYSTOOLS.zh-CN.md) | Windows 系统维护控制台 |
| [TERMINAL.zh-CN.md](./docs/features/TERMINAL.zh-CN.md) | 伪终端页面 |
| [THIRD_PARTY_LICENSES.zh-CN.md](./docs/features/THIRD_PARTY_LICENSES.zh-CN.md) | 关于窗口中的第三方许可对话框 |

## 发布与自动更新

`pnpm release:version` 是发布入口。它会检查工作区是否干净、当前分支是否为 `main`、
`package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 三处版本是否一致，
然后同时更新三处、提交并打上 `vX.Y.Z` 标签。推送标签会触发 GitHub Actions 工作流，
把安装包构建进一个**草稿** Release，其描述由上一个 tag 以来的提交自动生成。检查无误后
再手动发布——updater 只会读取已发布的 Release。

```bash
pnpm release:version
```

签名密钥为 `wingharness.key` / `wingharness.key.pub`。`scripts/build.ps1` 默认从仓库
根目录的 `.key/` 读取，也可以用 `-PrivateKeyPath` / `-PublicKeyPath` 指向别处；手动
走 `$HOME/.tauri` 的写法见 `.remake`。CI 里通过 `TAURI_SIGNING_*` 仓库 Secret 提供。

## 许可证

GNU 通用公共许可证第 3 版（仅此版本，GPL-3.0-only）。见 [LICENSE](./LICENSE)。

版权所有 (C) 2026 Anfioo。

第三方组件各自保留其许可证，见
[THIRD_PARTY_NOTICES.zh-CN.md](./THIRD_PARTY_NOTICES.zh-CN.md)，许可证文本放在
[licenses/](./licenses/)。每个已移植子系统的来源，以及哪些上游项目不得移植，记录在
[docs/UPSTREAM_PROJECTS.zh-CN.md](./docs/UPSTREAM_PROJECTS.zh-CN.md)。

## 贡献

欢迎贡献。请先读 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)：开发环境、
提交信息格式，以及从上游项目移植代码的规则都在那里。