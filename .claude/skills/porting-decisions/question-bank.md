# 冲突问题库

16 类冲突，逐类过一遍。每类给：**怎么取证** → **问不问** → **问法** → **默认建议**。

取证一律先读文件；查不到写「待核实」。本仓路径写相对仓库根的路径，命令在仓库根执行。

---

## 1 框架与版本冲突

**取证**：两侧 `package.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 里同名依赖的版本；源的构建方式（全局脚本 / 打包器）。

```powershell
Select-String -Path src-tauri/Cargo.toml -Pattern "react|tauri|codemirror|sqlite"
Get-Content .dev/Projects/<src>/package.json
```

**问不问**：只在「必须同时装两套」时才问（如源功能依赖 CM5 的某个插件而本仓只有 CM6）。否则默认。

**问法**：「源的编辑内核是 CodeMirror 5，本仓是 6。是重写适配层，还是为这个功能单独装 CM5？」

**默认**：按本仓版本重写适配层；不为兼容旧版并行安装第二套运行时。

**典型冲突**：CodeMirror 5↔6、React 17↔19、Tauri v1↔v2、rusqlite↔sqlx、Vue↔React、原生 JS↔TS strict。

---

## 2 UI 体系冲突

**取证**：源是否自带 CSS 文件（行数）、组件库；本仓 `tailwindcss` + `src/components/ui/`。

**问不问**：不问。事实清楚时直接定。

**默认**：参考交互与信息层级，用 Tailwind v4 + shadcn/ui 重写；不搬源的样式表。导出/打印类样式例外（显式色值，不依赖主题变量）。

---

## 3 信息架构与布局

**取证**：源的导航结构（左栏 / 顶部 / 多面板 / 标签）；本仓 `app-shell.tsx` 是 `SidebarProvider` + 左侧可折叠 `AppSidebar` + 48px 页头，页面内容在 `SidebarInset` 内。

**问不问**：**问**。源的布局是产品的一部分，改成什么样用户才有决定权。

**问法**：「源的导航是左侧固定栏 + 主区。是本仓侧栏 + 页内二级导航（推荐），还是在页面内自绘三栏复刻源布局，还是走独立窗口？」

**默认**：保留信息架构，套本仓外壳；页内用标签/分栏承载源的子面板。

---

## 4 窗口模型

**取证**：源是否有独立窗口、一窗口一文档、多实例；本仓 `src/main.tsx` 的 `standalonePaths` 与 `src/lib/*-windows.ts` 的现有先例（`git-windows.ts`、`svn-windows.ts`、`api-windows.ts`）。

**问不问**：**问**。

**问法**：「源是一窗口一文档。本仓三种先例：单页 + 标签（如 md-editor）、页面 + 一实例一窗口（如 git-repo）、纯独立窗口。选哪种？」

**默认**：单页 + 标签，除非源的核心价值就是多窗口并列。

**代价提示**：新增窗口要动 `standalonePaths`、`tauri.conf.json`、`capabilities` 的 `windows`，三处漏一处运行时被 ACL 拒绝。

---

## 5 功能范围裁剪

**取证**：源的页面/模块清单 + 每个模块行数；发布时间/README 的能力列表。

```powershell
Get-ChildItem .dev/Projects/<src>/src -Recurse -File |
  Group-Object DirectoryName |
  ForEach-Object { [pscustomobject]@{ Dir=$_.Name; Files=$_.Count; Lines=($_.Group | Get-Content | Measure-Object -Line).Lines } }
```

**问不问**：**问**，这是工作量与风险的最大变量。

**问法**：「源有 12 个模块。本期做哪几个？其余标『明确不做』写进计划 §1.2。」给出 3 个范围档位（核心 / 核心+高级 / 全量）。

**默认**：核心闭环优先；每个不做项写理由，不只写「不做」。

---

## 6 存储与数据迁移

**取证**：源用 SQLite / localStorage / keyring / JSON 文件；本仓 `config::dir()`（`src-tauri/src/config/mod.rs`），现有模块都用 JSON + 原子写。

**问不问**：存储介质本身不问（本仓约定 JSON）；**旧数据是否迁移必须问**。

**问法**：「源把档案存 SQLite。本仓统一 JSON。历史数据要不要导入？导入则多一套一次性迁移代码与测试。」

**默认**：不迁移旧数据；存储落 `config::dir()/<module>/`，`<file>.tmp` → `sync_all` → `rename`，损坏备份 `.bak-<ts>`。

---

## 7 凭据与敏感数据

**取证**：源是否用 keyring / 系统凭据库 / 明文；本仓先例（server-core、frp-core 的明文 + UI 掩码）。

**问不问**：**问**。这是安全取舍，不能替用户定。

**问法**：「源的 Token 存系统凭据库。本仓现有模块是明文 JSON + UI 掩码（数据目录可整体迁移）。跟本仓一致，还是不存凭据每次输入，还是引入 keyring？」

**默认**：跟本仓一致（明文 + 掩码 + 日志脱敏），并在功能文档里写明数据目录敏感性。

---

## 8 平台与运行时依赖

**取证**：源是否调用 `git`/`svn`/`frpc`/浏览器/系统命令；是否依赖 macOS/Linux 专有 API；本仓只在 Windows 验收。

**问不问**：平台差异不问（默认只 Windows 验收）；**需要用户安装外部二进制时问**。

**问法**：「这个功能要用户本机有 `git`。是探测 PATH 并给出引导（推荐），还是内置/下载一份？」

**默认**：探测本机、不内置下载；找不到时返回结构化错误并给引导文案。跨平台代码保留 `cfg` 分支，但只验收 Windows。

---

## 9 许可

**取证**：两端 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`docs/UPSTREAM_PROJECTS.md`。

**问不问**：兼容（AGPL/GPL-3.0/MIT/BSD/ISC/Apache-2.0/MPL/LGPL）不问，直接补归属；**无许可证或被准入表拒绝的许可证必须问**。

**问法**：「源的许可证是 X，本仓是 AGPL-3.0-only。按 `docs/UPSTREAM_PROJECTS.md` 的准入表，X 不在允许列表里，不能直接搬。是只参考行为自己实现（推荐），还是放弃这个模块？」

**默认**：允许的协议也要补：移植文件署名头、整子系统 `UPSTREAM.md`、`THIRD_PARTY_NOTICES.md`、`docs/UPSTREAM_PROJECTS.md`（及 `.zh-CN.md`）。

---

## 10 复用本仓已有能力

**取证**：本仓已有的编辑器（codelet / CM6）、预览渲染（`src/lib/preview/`）、虚拟列表（`@tanstack/react-virtual`）、格式化（`src/lib/*`）、resizable panels、sonner。

**问不问**：不问。默认先复用。

**默认**：能复用就复用；源自带的同类能力不重复引入。清单写进计划 §7.4「可复用资产」。

---

## 11 交互：快捷键与右键菜单

**取证**：源的快捷键表、右键菜单；本仓 `src/lib/shortcut.ts` 与 `use-app-translation` 等全局监听；注意与现有全局快捷键冲突。

**问不问**：只在冲突会导致系统级抢占时问。

**问法**：「源的 Ctrl+Shift+X 与本仓已有全局快捷键冲突。改为页面内快捷键（推荐），还是换组合键？」

**默认**：页面内处理，不注册系统级快捷键；编辑器内核的 keymap 优先级高于页面全局监听。

---

## 12 命名

**取证**：现有 crate 名单（`src-tauri/Cargo.toml` 的 `[workspace] members`，已有 11 个 `-core`）、路由 id（`app-routes.ts`）、i18n 命名空间目录（`src/i18n/locales/`）、命令前缀（`build.rs`）。

**问不问**：不问，命名冲突时自动加模块前缀。

**默认**：crate `<module>-core`、命令 `<module>_<verb>`、route id 驼峰、i18n 命名空间 `<module>`、侧栏 group 同名。

---

## 13 依赖体积与原生库

**取证**：源新增依赖是否有原生模块、体积、是否需要构建工具链；本仓 `package.json` 已有依赖。

**问不问**：>500KB、引入原生库、或与现有包功能重叠时问。

**问法**：「这个功能要新增 `canvas` 原生依赖。是接受体积，还是用现有的 SVG `foreignObject` 路线（推荐，零新增依赖）？」

**默认**：能不装就不装；先找现有依赖的等价实现。

---

## 14 测试差异

**取证**：源有无测试框架、用例数；本仓只做 Rust 单测 + 前端纯函数，未配 Vitest。

**问不问**：不问。

**默认**：crate 内 `#[cfg(test)]` 覆盖纯逻辑与边界；依赖真实外部进程/网络的用例标 `#[ignore]`；前端靠 `pnpm build` + 定向 eslint + 手工清单。

---

## 15 文档与上游归属

**取证**：本仓 `docs/features/<NAME>.md` + `.zh-CN.md`、`README` 表格、`UPSTREAM_PROJECTS.md`。

**问不问**：不问。

**默认**：功能文档双语成对，README 两张表同步加行；整子系统加 `UPSTREAM.md`；`THIRD_PARTY_NOTICES.md` 与移植记录同一次改动更新。

---

## 16 更新、托盘与发布链

**取证**：源是否自带自动更新、托盘、开机启动、安装包逻辑；本仓已有 `docs/AUTO_UPDATE.md` 与自己的更新链。

**问不问**：不问，默认不移植。

**默认**：只移植功能本体；更新/托盘/自启一律不搬，避免第二套发布链。

---

## 提问排序

1. 阻塞 A0 的：范围、交付形态、窗口模型、许可。
2. 影响数据与安全的：存储迁移、凭据。
3. 影响工作量的：复用取舍、外部运行时、依赖体积。
4. 其余全部落「计划默认」，在 `decisions.md` §4 列成表。

## 每个选项的写法

选项描述要写**代价**，不是复述名字：

- 好：`A（推荐）：套本仓侧栏 + 页内二级导航；代价：源的三栏布局要重排，工时 +2 人日`
- 差：`A：用本仓侧栏`
