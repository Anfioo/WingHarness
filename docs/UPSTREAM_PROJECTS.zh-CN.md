# 上游项目与移植记录

WingHarness 源自作者自己的私有工作流应用
[MaBangProjectsWorkflows](https://github.com/Anfioo/MaBangProjectsWorkflows)，
现在已经在自己的仓库中承载了那个应用的功能。而 MaBang 自身又承载了一批开源项目
的代码，所以每个移植功能的上游是一条**链**：上游项目 → MaBangProjectsWorkflows
→ WingHarness。

这份文件是这条链的唯一记录，有两个目的：

1. **许可证卫生。** WingHarness 采用 GPL-3.0-only。只有与本项目兼容的许可证才
   允许移植，并且声明必须随代码一起走。
2. **移植记录。** 它说明哪些上游已经在这里，以及哪些绝对不能拿。

实际随本仓库分发的第三方内容列在
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。本文件额外记录那些只是
读过的项目。

## 状态

| 状态 | 含义 |
|------|------|
| **已移植** | 该项目的代码或数据已经在本仓库中。 |
| **仅参考** | 为行为或设计而阅读；两个仓库中都没有它的代码。 |

## 许可证门槛

只有下列许可证的项目允许移植进 WingHarness：

| 上游许可证 | 是否允许移植 | 原因 |
|------------|--------------|------|
| GPL-3.0-only / GPL-3.0-or-later | 允许 | 与本项目同一许可证。 |
| MIT、BSD-2/3-Clause、ISC、MIT-0 | 允许 | 宽松许可，与 GPL-3.0 兼容。 |
| Apache-2.0 | 允许 | 与 GPL-3.0 单向兼容。 |
| MPL-2.0、LGPL-2.1/3.0 | 允许，作为库或文件级组件 | 弱著佐权，与 GPL-3.0 兼容。 |
| AGPL-3.0 | **禁止** | 会要求整个项目改为 AGPL-3.0。 |
| 没有许可证文件 | **禁止** | 默认版权归作者所有（all rights reserved）。先取得作者许可。 |
| “保留所有权利”、非商业或自定义条款 | **禁止** | 不兼容。 |

拿不准时就不要移植。向上游作者取得书面许可，并把许可记录写进
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 清单

### 已移植进本仓库

证据列记录移植核验时发现的内容：对移植文件与各检出做 SHA-256 比对，以及全源码
范围内的项目名检索（2026-11-05）。

| 上游 | 许可证 | 模块 | 证据 |
|------|--------|------|------|
| [tweakcn](https://github.com/jnsahaj/tweakcn) | Apache-2.0 | `src/lib/theme/presets.json` | 生成的数据快照；`licenses/tweakcn-LICENSE.txt` |
| [MangoDisk](https://github.com/harry0703/MangoDisk) | GPL-3.0-only | `systools-core`、`systools` 页面 | 导入时 10 个逐字节相同的文件；`systools-core/UPSTREAM.md` |
| [TizuMark](https://github.com/tizuio/TizuMark-Markdown-Editor) | GPL-3.0-only | `md-editor-core`、`md-editor` 页面 | 属改写，无相同文件；`md-editor-core/UPSTREAM.md` |
| [angkorgit](https://github.com/cheat2001/angkorgit) | MIT | `git-core`、`git-repo` 页面 | 导入时 16 个逐字节相同的文件，当前仍有 7 个；`git-core/UPSTREAM.md` |
| [OrcaSVN](https://github.com/wustites/OrcaSVN) | MIT | `svn-core`、`svn-workspace` 页面 | 整体移植；`svn-core/UPSTREAM.md` |
| [shaic](https://github.com/dariocurr/shaic) | MIT | `shaic-core`、`ai-config` 页面 | 导入时 51 个逐字节相同的文件，当前仍有 50 个；`shaic-core/UPSTREAM.md` |
| [McpHub](https://github.com/Soflutionltd/McpHub) | MIT | `src-tauri/src/mcphub`、`mcp-hub` 页面 | 每个源文件都保留归属声明 |
| [XTerm](https://github.com/Rockytkg/XTerm) | MIT | `server-core`、`servers` 页面 | 属改写，无相同文件；`server-core/UPSTREAM.md` |
| [Frpilot](https://github.com/leapfu/frpilot) | MIT | `frp-core`、`frp` 页面 | 属改写，无相同文件；`frp-core/UPSTREAM.md` |
| [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) | MIT | `claude-chat` 页面、`claude_history.rs` | 行为移植；1 个相同的通用小工具 `cn.ts` |
| [use-claude](https://github.com/ekaone/use-claude) | MIT | `src/lib/use-claude` | 文件头注明 Vendored from `@ekaone/use-claude` (MIT) |
| [cc-switch](https://github.com/farion1231/cc-switch) | MIT | `ccs`、`cc-switch` 页面 | 图标取自其 `src/icons/extracted`；读取其 SQLite 数据库 |
| [openidea](https://github.com/l0ng-ai/openidea) | Apache-2.0 | `db-core`、数据库页面（`src/pages/database`）：SQL 编辑器、结果表格、对象树、工作区页签、执行计划 | 按本项目约定改写，无相同文件；`db-core/UPSTREAM.md` 与 `src/pages/database/UPSTREAM.md` |

**这一组的说明**

- **MangoDisk** 与 **TizuMark** 是 GPL-3.0-only。正因为承载了它们，WingHarness
  才是 GPL-3.0-only 而不是 MIT。
- **cc-switch** 主要是集成而非复制：应用读取 `~/.cc-switch/cc-switch.db`。唯一逐
  字节相同的文件是它的 `hermes.png` 图标，声明仍然必须随行。
- 每个整块搬过来的 crate 或子系统都保留一份目录级 `UPSTREAM.md`：`git-core`、
  `svn-core`、`systools-core`、`md-editor-core`、`frp-core`、`server-core`、
  `shaic-core` 与 `db-core`。各上游的许可证文本放在 `licenses/`；GPL 上游指向本项
  目的 `LICENSE`。

### 仅参考 —— 未复制代码

| 上游 | 许可证 | 参考内容 |
|------|--------|----------|
| [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) | GPL-3.0-only | Clash 页面的设计；`prism-core` 本身是第一方代码，建立在 `clash-prism-extension` crate 之上 |
| [Rust-Frp](https://github.com/Nu0vo1212/Rust-Frp) | Apache-2.0 | FRP 协议与进程行为 |
| [Zephyr](https://github.com/Juwan-Hwang/Zephyr) | MIT | Mihomo GUI 设计 |

## 移植检查清单

每移植一个功能都按此执行。

1. **确认上游。** 沿着链找到最初的原始项目，而不只是 MaBang。查的是**原始项目**
   的许可证，而不是中间副本的。
2. **对照门槛。** 许可证必须在上面允许的列表内。上游没有许可证就停下来去问。
3. **记录版本。** 在移植条目中记下上游版本与提交（或写在该目录的 `UPSTREAM.md`
   中，见下）。
4. **保留署名头。** 每个移植文件开头都写一行注释，注明上游项目与许可证。
5. **为整目录写 `UPSTREAM.md`。** 整个 crate 或子系统被搬过来时写它，记录来源、
   版本、改了什么、以后如何跟进上游变更。可参照
   `src-tauri/shaic-core/UPSTREAM.md`。
6. **更新声明。** 把项目加进
   [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，并在此处翻转状态。
7. **补文档。** 在 `docs/features/` 下补双语指南（`FEATURE.md` 与 `FEATURE.zh-CN.md`），
   并在两个 README 中挂上链接。
8. **验证构建。** `pnpm check`，再加上该功能自己的冒烟测试。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-11-05 | 创建本文件；清单由两个仓库及其 `.dev` 检出目录整理得出。 |
| 2026-11-05 | 重新核验：对 MaBang `src/`、`src-tauri/`、`scripts/` 下每个文件做哈希并与各检出比对，同时全源码检索每个项目名。 |
| 2026-11-05 | WingHarness 吸收 MaBangProjectsWorkflows 的代码树；所有待移植模块均已进入本仓库，状态翻转为**已移植**。 |
| 2026-11-05 | 许可证审查：上游许可证文本补入 `licenses/`，每个已移植 crate 补署名头与 `UPSTREAM.md`，tweakcn 由 MIT 更正为 Apache-2.0，证据列更新为当前代码树状态。 |
| 2026-11-06 | openidea 由**仅参考**翻转为**已移植**：其 `crates/ide-db` 成为 `src-tauri/db-core`，`db-core/UPSTREAM.md` 记录差异。 |
| 2026-11-06 | 数据库 P2：把 `ide-db` 的内省部分（`sql.rs` 的目录查询、`lib.rs` 的 DTO）加入为 `db-core/src/{sql,objects}.rs`，对应 `db_databases`、`db_schemas`、`db_tables`、`db_table_details`、`db_schema_objects`。 |
| 2026-11-07 | 数据库 P3：多语句执行、表分页与行编辑、DDL 生成、补全、带页签的窗口与 CodeMirror 控制台，取自 `ide-db` 及 openidea 的前端；新增 `src/pages/database/UPSTREAM.md`，更新 `db-core/UPSTREAM.md`。 |
| 2026-11-07 | 数据库 P4（工作区）：查询文件、页签持久化与行数上限作为本仓原创的 `db-core` 工作区，执行计划取自 `ide-db` 的 `plan.rs`；树分组、表格交互与页签栏行为对齐 openidea。已更新 `db-core/UPSTREAM.md` 与 `src/pages/database/UPSTREAM.md`。 |
