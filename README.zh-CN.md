<div align="center">

# WingHarness

[English](./README.md) | 简体中文

[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

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
- **只读文件预览** —— Word、Excel、PowerPoint、PDF、图片、压缩包、电子书、PSD、XMind、音视频，全部在 webview 里解析
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
pnpm tauri dev      # Vite 开发服务器在 :11420，同时启动应用
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
│   ├── pages/                # 主窗口页面：start、local-terminal、notes、file-preview、project
│   ├── windows/              # 独立窗口路由：about、settings、tray-menu
│   ├── components/           # 外壳、标题栏、侧边栏、文件预览、shadcn/ui 原语
│   ├── lib/                  # router、app-routes、editor、preview viewers、fonts、terminal、theme
│   ├── commands/             # Tauri 命令的类型化封装（一域一模块）
│   ├── hooks/                # 共享 React hooks
│   └── i18n/                 # i18next 配置与 locales/{en,zh}.json
├── src-tauri/                # 后端（Rust）
│   ├── src/                  # commands/、config/、fonts/、theme/、plugins/（托盘）
│   ├── file-preview/         # workspace crate：预览页的字节读取
│   └── tauri.conf.json       # 窗口、打包与更新配置
├── docs/                     # 保留功能的说明文档
└── scripts/                  # 版本发布、主题预设、build.ps1
```

## 页面与窗口

| 路由 | 文件 | 类型 |
|------|------|------|
| `/` | `pages/start/index.tsx` | 主窗口 |
| `/local-terminal` | `pages/local-terminal/index.tsx` | 主窗口 |
| `/notes` | `pages/notes/index.tsx` | 主窗口 |
| `/file-preview` | `pages/file-preview/index.tsx` | 主窗口 |
| `/project` | `pages/project/index.tsx` | 主窗口 |
| `/about` | `windows/about/index.tsx` | 独立窗口 |
| `/settings` | `windows/settings/index.tsx` | 独立窗口 |
| `/tray-menu` | `windows/tray-menu/index.tsx` | 独立窗口 |

主窗口页面由共享的 `AppShell` 包住；三个独立窗口路由写在 `standalonePaths` 里，
自带外壳。

## 如何扩展

### 新增页面

1. 新建 `src/pages/<name>/index.tsx`，内容用 `<AppShell>` 包住
2. 在 `src/main.tsx` 的 `pageMap` 里加一条
3. 在 `src/lib/app-routes.ts` 的 `appRoutes` 里加一行（id、path、icon）
4. 在两个语言文件里补 `routes.<id>.{title,scope,description}`

### 新增 Tauri 命令

一条命令必须在四个地方登记，否则运行时会被 ACL 拒绝——见
[src-tauri/CLAUDE.md](./src-tauri/CLAUDE.md)。前两处不一致时 `build.rs` 会让构建失败。

### 新增 shadcn/ui 组件

```bash
pnpm dlx shadcn@latest add button
```

## 文档

| 文档 | 内容 |
|------|------|
| [docs/AUTO_UPDATE.md](./docs/AUTO_UPDATE.md) | 更新端点、签名密钥、GitHub Actions 发布流程 |
| [docs/FILE_PREVIEW.md](./docs/FILE_PREVIEW.md) | 预览子系统、支持的格式、如何新增一种格式 |
| [docs/GLOBAL_SHORTCUT.md](./docs/GLOBAL_SHORTCUT.md) | 向操作系统注册快捷键 |
| [docs/I18N.md](./docs/I18N.md) | i18next 配置与新增语言 |

## 发布与自动更新

`pnpm release:version` 是发布入口。它会检查工作区是否干净、当前分支是否为 `main`、
`package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 三处版本是否一致，
然后同时更新三处、提交并打上 `vX.Y.Z` 标签。推送标签会触发 GitHub Actions 工作流，
构建安装包并发布 updater 所读取的 release。

```bash
pnpm release:version
```

签名密钥为 `wingharness.key` / `wingharness.key.pub`。`scripts/build.ps1` 默认从仓库
根目录的 `.key/` 读取，也可以用 `-PrivateKeyPath` / `-PublicKeyPath` 指向别处；手动
走 `$HOME/.tauri` 的写法见 `.remake`。CI 里通过 `TAURI_SIGNING_*` 仓库 Secret 提供。

## 许可证

MIT