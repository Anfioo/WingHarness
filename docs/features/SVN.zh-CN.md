# SVN 工作副本

**SVN 工作副本**页面是一个原生 Subversion 客户端。它位于侧边栏的「工作台」
分组，紧邻 Git 仓库页面，形态是选择器加每个工作副本一个窗口。

它是原生客户端而非桥接：直接与本机的 `svn` 二进制通信，把状态保存在数据目录
下，与 Git 仓库页面不共享任何东西。

crate 是 [`src-tauri/svn-core`](../../src-tauri/svn-core)，改编自
[OrcaSVN](https://github.com/wustites/OrcaSVN)（MIT）。它不实现 SVN 协议的
任何部分——它启动 `svn`、解析输出，并缓存文件系统快照，以免白白重复询问。

## 窗口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/svn-workspace` | 选择器：打开与最近的工作副本 |
| `/svn-workspace-window?path=…` | 一个工作副本 |
| `/svn-workspace-diff?path=…&target=…&old=…&new=…` | 单个文件差异，独立窗口 |

窗口标签是 `svn-wc-` 和 `svn-diff-` 后接规范化路径的 FNV-1a 64 位哈希
（差异窗口则为 `path|target|old|new`）。重新打开一个工作副本会聚焦已经存在
的窗口。两个前缀都必须列入
[`capabilities/default.json`](../../src-tauri/capabilities/default.json)，否则
窗口在运行时失败。

选择器不会被告知窗口已关闭：它在重新获得焦点或变为可见时重新扫描
`getAllWebviewWindows()`。

## 工作副本窗口做什么

带过滤的状态列表、差异窗格，以及作用于选中项的操作：update、commit（整个
工作副本或仅选中文件）、switch、merge、cleanup、add、delete、revert、
resolve，以及 `svn apply-patch`。日志、差异与 blame 可按文件使用，本地货架
存储变更——包括未版本控制的文件——因此工作副本可以回到已知状态而无需提交。

## 工作原理

```
React page and panels (src/pages/svn-workspace, src/features/svn-workspace)
  └─ src/commands.ts wrappers
       └─ svn-core::commands       33 thin #[tauri::command] adapters
            ├─ operations.rs       update / commit / switch / merge / add / …
            ├─ status_cache.rs     in-memory status per working copy
            ├─ store.rs            recent list, JSON stores, atomic writes
            ├─ unversioned.rs      read / restore / delete unversioned files
            ├─ gitignore.rs        reads .gitignore + mtime (matching is frontend)
            └─ executor.rs         spawns svn.exe, parses with parser.rs
```

一次状态刷新：

```
workspace-view timer (60 s) → refreshStatusIfStale → svn_status(path, force?)
  status_cache::cached_status
    scan(root, baseline) → status_snapshot::scan
        Windows NTFS? status_usn::probe (journal) : metadata inventory
    unchanged → cached entries
    changed   → svn status --xml --depth empty -- <paths>, in chunks
                (or a full svn status --xml)
    spawn_blocking: verify() then write cache/status-<hash>.json
```

## 命令

三十三个命令，通过 `src-tauri/src/invoke.rs`、`build.rs` 与
`capabilities/default.json` 注册。

| 区域 | 命令 |
| --- | --- |
| 环境 | `configure_svn_executable` |
| 存储与最近 | `svn_workspace_recent`、`svn_workspace_remember`、`svn_workspace_forget`、`svn_store_read`、`svn_store_write`、`svn_store_remove`、`svn_stash_export` |
| 状态 | `svn_status` |
| 更新与提交 | `svn_update`、`svn_commit`、`svn_switch`、`svn_merge`、`svn_cleanup` |
| 信息 | `svn_info`、`svn_remote_info`、`svn_local_revision`、`svn_current_user` |
| 日志、差异、blame | `svn_log`、`svn_diff`、`svn_blame` |
| 检出 | `svn_checkout` |
| 按路径编辑 | `svn_add`、`svn_delete`、`svn_revert`、`svn_resolve`、`svn_apply_patch` |
| 未版本控制文件 | `delete_unversioned`、`read_unversioned_files`、`restore_unversioned_files` |
| Shell 集成 | `open_workspace_target`、`reveal_workspace_file`、`read_gitignore` |

每个运行 `svn` 的操作都返回 `CommandResult { success, output, error }`，而
不是类型化结果，因为有用的诊断信息就是 `svn` 打印的内容。线路类型为
camelCase，与 [`src/lib/svn-core/types.ts`](../../src/lib/svn-core/types.ts)
一致。

## 数据布局

`CONFIG_DIR` 在应用启动时设为 `<data dir>/.svn-workspace`。如果启动时跳过
它，每个命令都会以 "the data directory has not been initialised" 失败。

```
<data dir>/.svn-workspace/
├── recent-workspaces.json           # path, revision, openedAt (max 20)
├── cache/
│   └── status-<fnv1a64(root)>.json  # version 6, root, inventory, entries
├── svn-settings.json                # zustand persist document
├── svn-stashes.json                 # the local shelf
└── svn-commit-draft.json            # the message being typed
```

写入使用与其他模块相同的原子模式：将 `<name>.<nanos>.json.tmp` 重命名覆盖
目标，失败时删除临时文件。状态缓存保留最新的五个文件，预算为 64 MiB，并且
只有在版本、根、目录索引与 24 小时时限全部仍然成立时才会复用。

## 值得了解的行为

**状态解析。** `svn status --xml` 按 XML 解析，而不是按列，因此含空格的
文件名是安全的。Windows 上路径规范化为 `/`。除非属性发生变化或记录了冲突，
否则丢弃 `normal`/`none` 条目；被折叠的 `deleted`/`replaced` 目录会用一次
`--verbose` 重新展开，使其子项逐个重现。

**缓存失效。** 变更检测不询问 SVN。它比较文件系统清单（路径、逻辑大小、
纳秒级 mtime、ctime、符号链接目标），以及 `svn` 二进制路径、Subversion 的
`config` 与 `servers` 文件（哈希后保存，从不存原文）和各级 `.svn` 树的
指纹。NTFS 上由 USN 日志提供候选路径。只要有结构性变化——出现重解析点、
日志重置、管理员元数据被改动——结果就是完整扫描。无论是否变化，每五分钟也
会执行一次完整扫描。

**部分提交。** `svn commit --depth empty -- <files>`——空选择会被拒绝。提交
之前会重新读取状态，如果提交会漏掉已复制或已移动目录的子项
（`history && is_dir`），或漏掉 `deleted`/`replaced` 目录的子项，则拒绝提交。
拒绝信息会说明属于哪一种情况。

**本地货架。** stash 时用 `svn diff` 逐个文件取差异，将结果拆成 hunk，重建
补丁，在触碰工作副本**之前**先持久化货架条目，然后反向应用该补丁，并删除
属于该条目的未版本控制文件。恢复按相反顺序执行：先试运行未版本控制恢复，
再正向应用补丁，最后真正恢复。无法应用的 hunk 会让条目留在原处
（"saved but not hidden"），而不是静默丢失变更。未版本控制内容以 base64
存储，整个条目上限 2 MiB，拒绝符号链接，且每个路径都被沙箱限制在工作副本
内。

**gitignore。** Rust 侧只读取 `.gitignore` 及其 mtime；匹配在前端完成，
支持最后规则优先与否定规则。过滤**默认关闭**（`gitignoreEnabled`），因为
SVN 工作副本中被忽略的文件仍然是 SVN 跟踪的文件。

**凭据。** 不存储任何凭据。`svn_current_user` 调用 `svn auth` 并解析 realm
与用户名，以便界面显示当前登录者；信任决策属于 Subversion 本身
（`servers`、`config`、Windows 凭据存储）。由于每次调用都传
`--non-interactive`，认证提示会让命令失败，而不是挂起应用。

**调用。** `svn.exe` 可在运行时配置，用 `--version --quiet` 校验，以工作
副本作为当前目录启动，`--non-interactive` 永远放在最前，使用
`kill_on_drop`，Windows 上不弹出控制台窗口。输出以 UTF-8 有损解码，错误
信息合并 stdout 与 stderr。

## 限制

| 限制 | 取值 |
| --- | --- |
| 单次 `svn` 调用 | 120 秒，超时返回 `SvnError::Timeout` |
| 状态缓存 | 内存中 3 个工作副本，5 个快照文件，64 MiB |
| 状态快照 | 500 000 个节点，16 MiB 日志回放 |
| 未版本控制货架条目 | 合计 2 MiB |
| 最近工作副本 | 20 |

未实现：`propset`/`propget`/`propedit`、lock/unlock、copy/move/branch/tag、
export/import、relocate/upgrade、changelists、`empty` 以外的任何深度、按
hunk 丢弃，以及取消正在运行的命令。

blame 解析器是定宽的——SVN 把作者字段补齐到十个字符，作者更长会使该行被
跳过。未版本控制文件的 `svn diff` 以 `--- (nonexistent)` 和修订版 0/0 合成。

## 将本模块接入其他应用

1. 将 `svn-core` 加入 `src-tauri/Cargo.toml`，并从 `invoke.rs` 暴露其命令。
2. 在 `build.rs` 的 `COMMANDS` 中列出全部 33 个命令并授予
   `allow-<command>`；缺少 ACL 条目时调用会以 "not allowed by ACL" 失败。
3. 将 `svn-wc-*` 与 `svn-diff-*` 加入能力配置的窗口列表。
4. 在 setup 中设置 `svn_core::store::CONFIG_DIR`。
5. 前端需要 `src/pages/svn-workspace`、`src/features/svn-workspace`、
   `src/lib/svn-core`，以及计算标签的 `svn-windows.ts` 辅助文件。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| "svn is not installed or not on PATH" | 二进制缺失；用 `configure_svn_executable` 设置 |
| 任何命令都报 "not allowed by ACL" | 未在 `build.rs` 或 `capabilities/default.json` 中登记 |
| "the svn workspace data directory has not been initialised" | setup 期间从未设置 `CONFIG_DIR` |
| 工作副本窗口打不开 | 能力配置的窗口列表中缺少 `svn-wc-*` |
| 外部提交后状态列表仍是旧的 | 未满五分钟且清单未变化；强制刷新 |
| 刚打开时列表为空 | 快照已恢复，而 `svn_status` 仍在运行或已失败 |
| "svn operation timed out" | 触及 120 秒上限——通常是慢速链路上的一次大更新 |
| 提交拒绝 "must include all of its children" | 对已删除或已替换目录做部分提交 |
| 提交拒绝 "copied or moved directory" | 该目录有隐式子项；提交整个副本 |
| stash 已创建但变更仍在 | 反向补丁应用失败；条目被保留 |
| 恢复 stash 时提示路径已存在 | 未版本控制文件在 stash 之后被重新创建 |
| "unversioned files exceed the 2 MB stash limit" | 条目太大，无法捕获 |
| 被忽略的文件仍然列出 | `gitignoreEnabled` 关闭，或模式与 git 的语义不同 |
