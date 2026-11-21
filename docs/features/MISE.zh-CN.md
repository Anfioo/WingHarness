# 环境管理

**环境管理**页面读取本机的 `mise` 安装，列出它管理的工具与版本，扫描项目中的版本覆盖，并编辑全局与项目级 mise 配置。入口在侧栏的**其他**分组下，只有一个页面，不额外打开窗口。

引擎位于 [`src-tauri/mise-core`](../../src-tauri/mise-core)（crate 名 `mise-core`，库名 `mise_core`），移植自 [mise_gui](https://github.com/likaia/mise_gui)（MIT）；[mise-core/UPSTREAM.md](../../src-tauri/mise-core/UPSTREAM.md) 记录了移植内容与差异。

mise 本身**不随应用打包**。页面使用机器上已安装的 CLI；没有安装时显示安装命令，而不是直接报错。

## 路由与文件

| 路由 | 内容 |
| --- | --- |
| `/mise` | 页面：运行时徽标、四个标签（总览、工具、项目、配置） |

| 路径 | 职责 |
| --- | --- |
| `src/pages/mise/index.tsx` | 页面壳：运行时探测、页头、标签栏与安装引导 |
| `src/pages/mise/{overview,tools,projects,config}-tab.tsx` | 四个标签 |
| `src/hooks/use-mise-page.ts` | 运行时状态、当前标签与刷新计数 |
| `src/hooks/use-mise-{overview,tools,projects,config}.ts` | 每个标签一个 hook，各自持有数据 |
| `src/components/mise/` | 指标卡、状态徽标、提示、对话框、列表与面板 |
| `src/commands/services/mise/` | 十六条 `mise_*` 命令的类型化封装与 DTO |
| `src/lib/mise/` | 错误码映射、格式化辅助函数与纯函数式动作脚本生成 |
| `src-tauri/mise-core/src/` | 进程、运行时探测、历史、配置、工具、动作、项目与总览 |
| `src-tauri/src/invoke.rs` | 在 `all_commands!` 中登记十六条 `mise_*` 命令 |

没有 `standalonePaths` 条目，也没有窗口记录。侧栏分组 `mise` 刻意没有加入 `src/lib/sidebar-config.ts` 的 `GROUP_ORDER`，因此入口落在**其他**。

## 运行时探测

`mise_runtime_info` 按以下顺序解析可执行文件：

1. `MISE_EXECUTABLE`
2. `PATH` 的每一项（Windows 上先 `mise`，再 `mise.exe`）
3. 应用自己的 Scoop shim：`<data dir>/ScoopCurrent/shims/mise.exe`
4. 用户级安装位置：`~/.local/bin`、`~/scoop/shims`、`%LOCALAPPDATA%\Programs\mise\bin`

探测结果包含 `available`、可执行文件路径、版本（`mise --version`，15 秒）、来源（`path`、`scoop`、`direct`、`unknown`）与 shim 状态。Windows 上 shim 检查判断可执行文件所在目录是否在 `PATH` 中，取值为 `missing`、`present` 或 `unsupported`（非 Windows）。

mise 缺失是受支持的状态，不是错误：页面显示对应平台的安装命令（`winget install jdx.mise`、`brew install mise` 或 `curl https://mise.run | sh`），带复制按钮和重试。版本探测失败时 mise 仍然可用，只是版本留空。

## 标签

- **总览** —— 一条 `mise_dashboard` 负载：四项指标（系统、已装工具、已扫描项目、mise 版本）、环境信号、最近三条历史与系统信息。进入时加载一次，不轮询；页头的刷新会重新探测运行时并重挂当前标签。每个区块独立降级——即使没有 mise，也会得到零计数与一条提示，而不是整条命令失败。
- **工具** —— `mise_tools_list` 读取 `mise ls --json`（30 秒）。选中工具后调用 `mise_tool_detail`，重新读取该工具已安装的版本，再向仓库查询：Python 使用 `mise outdated`，其它后端使用 `mise ls-remote --json`，预算 90 秒并带取消令牌。取消会调用 `mise_tool_detail_cancel`，由后端停止请求，而不只是前端丢弃响应。远端查询失败时退回 `outdated` 条目或本地版本，并给出 `remote-unavailable` 提示。
- **项目** —— `mise_projects_scan` 扫描已打开的项目窗口与启用的自定义扫描根，见下方「项目覆盖」。
- **配置** —— `mise_config_workspace` 返回全局文档、所选项目文档，以及页面可编辑的结构化区块，见下方「配置编辑」。

## 项目覆盖

扫描范围恰好两个来源，不会引入第三套「最近项目」口径：

- 所有标签以 `project-` 开头的窗口，由 Rust 从窗口 URL 读取；
- `<data dir>/mise/scan_dirs.json` 中每一个**启用**的自定义扫描根。

每个根按广度优先扫描到三层，最多访问 240 个目录、收集 80 个项目。点目录与常见构建产物（`.git`、`.dart_tool`、`.idea`、`.vscode`、`build`、`dist`、`node_modules`）会跳过。

项目的配置文件按优先级读取：`mise.toml`、`.mise.local.toml`、`mise.local.toml`、`.tool-versions`，然后是单版本文件（`.node-version`、`.nvmrc`、`.python-version`、`.ruby-version`、`.java-version`、`.go-version`、`.terraform-version`）。工具名会归一化（`nodejs` → `node`、`golang` → `go`），并去掉前导 `v`。

每个声明的工具生成一条绑定，将项目版本与全局配置比较。来源为 `project`、`project-file`、`global`、`inherited` 或 `resolved`（由 mise 自己解析）。项目的备注为 `overrides`、`project-only`、`consistent` 或 `none`；无法向 mise 查询时，`scan_issue` 为 `not-trusted` 或 `unavailable`。单项目的 `mise ls` 预算为 30 秒；失败时该行退回文件声明的版本。

扫描根会被规范化、去重，并折叠到已启用的祖先下；停用的祖先会保留已启用的子目录。最多添加 50 个扫描根；添加已启用根的子目录会折叠，其它情况按原样保存。

## 动作与安全边界

工具动作在预览对话框打开之前，由 `src/lib/mise/commands.ts` 组装完成，所以用户确认的命令就是实际执行的命令。页面提供安装、切换（`mise use`）、升级（安装 + 切换）与卸载（一个版本，或从全局配置移除整个工具并删除所有已装版本）。

后端随后执行这些保护：

- 脚本在第一进程启动前逐行校验。空行与 `#` 注释跳过，其余每一行必须以 `mise ` 开头，参数中不得出现 shell 操作符。
- 每一行以 argv 数组启动，不经过 shell，因此引号无法变成命令注入。单条命令预算六分钟；第一个非零退出会停止后续命令。
- 同一时间只允许一个动作；再次触发返回 `busy`，不会启动第二个进程。
- 输出通过 `mise:action-progress` 事件流式推送；进度对话框最多保留 200 行日志。
- 动作失败时会清理 mise 留下的锁文件。只删除位于锁文件目录下的路径，其它路径只报告、不删除。
- 每次运行写入历史；取消预览会记一条 `canceled`。

卸载单个版本只删除本机安装，不改配置行。移除整个工具是显式的两条命令，同时从全局配置中删除它。

## 配置编辑

工作区暴露全局配置（`MISE_GLOBAL_CONFIG_FILE`，否则 `<home>/.config/mise/config.toml`），以及选中项目后的项目 TOML 文件。支持四种编辑：

| 类型 | 写入内容 |
| --- | --- |
| `document` | 整份文件，按用户输入 |
| `settings` | `[settings]` 下的键：`http_timeout`、`fetch_remote_versions_timeout`、`http_retries`、`offline`、`terminal_progress` |
| `proxy` | `[env]` 下的键：`http_proxy`、`https_proxy`、`all_proxy`、`no_proxy`，每项同时写小写与大写别名 |
| `aliases` | `[tool_alias.java.versions]` 映射 |

任何改动都不会直接落盘。`mise_config_preview_edit` 生成下一版内容与统一 diff；用户确认后，`mise_config_save` **只写入预览过的内容**。即使是手写或过期的 `nextContent`，仍会经过白名单校验。

**白名单。** 保存目标只能是全局配置文件，或已打开项目根／已启用扫描根下十一种已知配置文件名之一，且最多下探三层。其它路径——包括这些根之外的路径——返回 `invalid-input`，文件保持不变。超过 1 MiB 或不是合法 UTF-8 的文档同样拒绝。

**写入。** 先复制现有文件为 `<name>.bak-<unix seconds>`，再把新内容写到 `<name>.tmp`、刷盘并重命名覆盖目标。写入失败会删除临时文件，成功则不留下 `.tmp`。生成器只改动自己负责的行，因此其它段与注释得以保留。

## 历史

动作历史位于 `<data dir>/mise/history.json`，结构为 `{ "version": 1, "entries": […] }`，最新的在前。

- 最多 100 条；超过上限时丢弃最旧的。
- `stdout`、`stderr` 各自截断到 16 KiB，按字符边界截断；列表视图显示截断后前三行内容作为摘要。
- 写入是原子且串行的，两次追加不会互相覆盖。
- 文档无法读取时另存为 `history.json.bak-<unix seconds>`，列表从空开始，而不是报错。

总览显示最近三条；工具页的「查看全部」可展开完整输出。历史是文件而非 webview 状态，重启后仍在。

## 数据文件

| 路径 | 内容 |
| --- | --- |
| `<data dir>/mise/history.json` | 上文描述的动作历史 |
| `<data dir>/mise/scan_dirs.json` | `{ version: 1, directories: [{ path, enabled }] }`，已规范化，最多 50 条 |
| `<home>/.config/mise/config.toml` | mise 自己的全局配置，经白名单读写 |
| `%LOCALAPPDATA%\mise\installs` | mise 的安装目录，安装／卸载动作把它显示为受影响路径 |

mise 自己的文件不会被搬移或复制。页面只编辑全局配置（选中项目时还包括该项目的配置）。

## 错误码

每条被拒绝的命令返回 `{ code, message, detail }`；`message` 为英文，供日志使用，前端按 `code` 本地化。

| 错误码 | 含义 |
| --- | --- |
| `mise-not-found` | 找不到或无法启动 mise 可执行文件 |
| `not-found` | 请求的工具、项目或文件不存在 |
| `invalid-input` | 路径、文档或设置校验失败（包括白名单） |
| `unsafe-command` | 脚本行不是 `mise` 调用，或包含 shell 操作符 |
| `busy` | 已有动作正在执行 |
| `timeout` | mise 调用超出预算 |
| `io` | 文件读取、备份或写入失败 |
| `cancelled` | 请求被用户取消 |
| `not-implemented` | 调用了占位命令 |
| `internal` | mise 执行失败或输出无法解析（`detail` 带退出码与 stderr） |

## 命令

| 命令 | 用途 |
| --- | --- |
| `mise_runtime_info` | 探测可执行文件、版本与 shim |
| `mise_dashboard` | 总览负载 |
| `mise_tools_list` | 从 `mise ls --json` 读取已装工具 |
| `mise_tool_detail` / `mise_tool_detail_cancel` | 单个工具的本机版本与远端候选；取消该请求 |
| `mise_action_run` | 校验并执行动作脚本，流式输出进度 |
| `mise_projects_scan` | 扫描已打开项目与自定义根 |
| `mise_scan_dirs_list` / `_add` / `_remove` / `_set_enabled` | 管理自定义扫描根 |
| `mise_config_workspace` | 全局与项目文档，以及可编辑区块 |
| `mise_config_preview_edit` | 只生成下一版内容与 diff，不写盘 |
| `mise_config_save` | 写入预览过的内容，并生成备份 |
| `mise_history_list` / `mise_history_record_canceled` | 读取历史；记录取消的动作 |

十六条命令都在 `src-tauri/src/invoke.rs`、`build.rs`、`capabilities/default.json` 与 `permissions/autogenerated/mise_*.toml` 中登记。

## 权限

ACL 只把 `mise_*` 命令授予 `capabilities/default.json` 中列出的应用窗口。插件 webview 使用 `plugin-view-*` 标签，刻意不在该清单内，因此插件无法调用任何 `mise_*` 命令——这是 ACL 的默认拒绝，不是前端检查。

## 开发

```bash
cd src-tauri
cargo check -p mise-core
cargo test -p mise-core
cargo check
cd ..
pnpm build
pnpm exec eslint src/pages/mise src/components/mise src/hooks/use-mise-*.ts \
  src/commands/services/mise src/lib/mise
pnpm exec prettier --check src/pages/mise src/components/mise \
  src/hooks/use-mise-*.ts src/commands/services/mise src/lib/mise \
  src/i18n/locales/mise
```

需要真机的测试都标了 `#[ignore]`。用 `--ignored` 运行，部分还需环境变量：

| 测试 | 依赖 |
| --- | --- |
| `runtime::tests::real_runtime_probe_reports_the_executable` | 本机 mise |
| `process::tests::real_mise_*` | 本机 mise |
| `tools::tests::real_mise_lists_installed_tools` | 本机 mise |
| `tools::tests::real_mise_loads_remote_versions_for_a_tool` | 本机 mise 与网络 |
| `projects::tests::discovers_a_real_directory` | `MISE_PROJECT_SCAN_ROOT` 指向含 mise 项目的目录 |

mise 不在 `PATH` 中时设置 `MISE_EXECUTABLE`。
