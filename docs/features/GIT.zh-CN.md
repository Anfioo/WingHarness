# Git 仓库

**Git 仓库**页面是一个完整的本地 Git 客户端。它位于侧边栏的「工作台」分组，
形态与 SVN 工作副本一致：侧边栏页面是选择器，每个仓库在**独立窗口**中打开。

引擎是 [`src-tauri/git-core`](../../src-tauri/git-core)，一个基于 libgit2 的
Rust crate（`git2` 0.20，vendored）。常规操作从不启动 `git` 进程；`git`
二进制只用于诊断探测。客户端改编自
[angkorgit](https://github.com/cheat2001/angkorgit)（MIT）——许可声明随代码
一同保留。

## 窗口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/git-repo` | 选择器：打开、克隆与最近列表 |
| `/git-repo-window?path=…` | 一个仓库，无边框，独立窗口 |

仓库窗口的标签是 `git-repo-` 加上规范化路径（转小写、`\` → `/`）的 FNV-1a
64 位哈希，共 16 个十六进制字符。打开一个已经打开的路径会聚焦现有窗口，
而不是再开第二个——这也意味着同一路径的两种写法（大小写、末尾分隔符）会
产生两个窗口。

| 属性 | 取值 |
| --- | --- |
| 尺寸 | 1280 × 800，最小 1024 × 640 |
| 边框 | `decorations: false`，透明，无阴影 |
| 能力前缀 | [`capabilities/default.json`](../../src-tauri/capabilities/default.json) 中的 `git-repo-*` |
| 持久化的标签状态 | `src/features/git/repository/tabs.ts`，防抖 300 ms |

## 窗口内容

三个可调整大小的窗格：

- **轨道栏** —— 分支、工作树、远程、标签、stash 与子模块，每项都是带过滤框
  的可折叠分区。连接 forge 账号后，拉取请求分区会加入其中。分支可以互相
  拖拽，以执行合并、快进或变基。
- **中央** —— 提交图、差异视图与终端组成的垂直分割。中央还会在提交图、
  文件编辑器、文件历史与单文件差异视图之间切换，因此从工作副本打开的文件
  不会离开窗口。
- **检查器** —— 选中的提交、stash 或工作副本条目：其文件列表（列表或树）、
  差异、blame，以及针对单个文件的操作（编辑、历史、从 stash 中应用某个
  文件、在外部打开）。

底部状态栏显示领先/落后计数、变更文件数、冲突数，以及「创建拉取请求」操作。

## 前端如何到达引擎

```
page (src/pages/git-repo/*)
  └─ Zustand stores (src/features/git/*)
       └─ typed wrappers (src/commands/services/git/index.ts)
            └─ invoke("repo_open" | "stage_file" | …)
                 └─ git-core::commands::*      [libgit2, spawn_blocking]
                      └─ JSON back to the window
```

包装器与命令名一一对应，因此缺了哪个包装器，读文件即可发现。可选参数以
`null` 发送，而不是省略。

打开一个仓库：

```
repository-view.tsx → open(path)
  → repo_open { path, remember: true }
       Repository::discover → RepositoryInfo
       recent list pushed to .git-repo/recent-repositories.json
  → refresh(): repo_info, repo_status, branches, tags, stashes, remotes,
               submodules, conflicts, worktrees, unpushed commits
  → watch_repo { path } and listen("repo-changed")
```

## 命令

所有命令都在 `git-core/src/commands.rs` 中，并通过 `src-tauri/src/invoke.rs`、
`build.rs` 与 `capabilities/default.json` 注册。

| 区域 | 命令 |
| --- | --- |
| 仓库 | `repo_open`、`repo_clone`、`repo_info`、`repo_status`、`repo_init`、`repo_ref_fingerprint`、`repo_ignored_paths`、`repositories_scan`、`recent_*`、`state_cleanup` |
| 分支与引用 | `branch_*`、`checkout_detached`、`merge_*`、`rebase_*`、`cherry_pick*`、`revert_paths`、`reset_to` |
| 历史 | `history_*`、`history_unpushed`、`file_history`、`repo_files`、`tree_files`、`index_files`、`file_contents`、`file_blame` |
| 暂存与提交 | `stage_file`、`unstage_file`、`stage_all`、`unstage_all`、`stage_hunk`、`unstage_hunk`、`stage_line`、`unstage_line`、`discard_*`、`restore_from_rev`、`commit_*` |
| 差异 | `diff_*`、`staged_patch`、`patch_save` |
| 冲突 | `conflict_*`（列出、读取、解决） |
| 远程与 forge | `remote_*`、`pr_checkout`、`forge_request`、`http_request` |
| Stash、标签、子模块、工作树 | `stash_*`、`tag_*`、`submodule_*`、`worktree_*` |
| 账号与密钥 | `account_*`、`credential_*`、`ssh_*`、`ai_key_*`、`ai_cli_detect`、`ai_cli_run` |
| 终端与监视 | `term_create`、`term_write`、`term_resize`、`term_kill`、`watch_repo` |
| 文件与编辑器 | `read_file`、`write_file`、`delete_file`、`open_path`、`reveal_path`、`paths_exist`、`editors_detect`、`editor_open` |
| 诊断 | `git_cli_version`、`git_engine_info`、`config_get`、`config_set` |
| 小型键值存储 | `git_store_read`、`git_store_write`、`git_store_remove` |

`repo_open(path, remember?)` 返回一个 `RepositoryInfo`；`repo_clone` 在运行
期间流式发送 `clone-progress` 事件。错误序列化为 `{ code, message }`，其中
`auth`、`forbidden` 与 `plan_limit` 由 libgit2 报告的 HTTP 状态推导。

## 数据布局

该 crate 写入 `<data dir>/.git-repo`（`CONFIG_DIR`，在应用启动时设置一次）：

```
<data dir>/.git-repo/
├── recent-repositories.json     # path, name, lastOpenedAt, aiInstructions (max 1000)
├── accounts.json                # forge accounts; tokens live in the OS keyring
├── <key>.json                   # small per-feature stores, key = [a-z0-9-]{1,64}
└── ai-keys.json                 # AI provider keys for review (see below)
```

除最近列表外，每个存储都原子写入：将 `<nanos>.json.tmp` 重命名覆盖目标；
写入失败时删除临时文件。最近列表则是普通覆盖——写到一半崩溃会丢失它，应用
以空列表恢复，而不是启动失败。

Forge token 是唯一**不**落到 JSON 文件里的东西：它们进入操作系统 keyring，
服务名为 `AngKorGit`，键为 `acct:{host}:{username}`。只有 `http(s)` 远程会
做主机映射，并且每个 forge 请求在附加 token 前都会用该白名单校验主机。

## 值得了解的行为

**提交图。** 布局在前端执行
（[`graph-layout.ts`](../../src/lib/git-core/graph-layout.ts)）：每个提交为其
期望的父提交占用第一条空闲泳道，泳道按提交 OID 着色，合并/结束/穿越标记
按行计算。历史分页为 200 个提交，跨所有分支、远程、标签、`HEAD` 与 stash
使用 `Sort::TOPOLOGICAL | Sort::TIME`。短 OID 为 8 个字符；搜索与未推送
列表各上限 1 000 条。

**刷新由指纹驱动。** `watch_repo` 每个窗口运行一个防抖监视器（400 ms），
监视 `HEAD`、索引、引用与工作树指针，忽略 `objects/` 与 `*.lock`。触发时
窗口比较 `repo_ref_fingerprint`：未变化只刷新状态，变化则同时重新加载图。
由于忽略了 `objects/`，由其他工具执行的提交可能要到下一次索引或引用写入才
被发现——`Ctrl+R` 强制重新加载。

**暂存粒度。** 文件开关使用 `stage_file` / `unstage_file`（重置到 `HEAD`）。
hunk 与行级暂存会构建一个隔离补丁并应用到索引，因此部分暂存从不触碰工作
树。当差异面板显示整文件或不忽略空白的输出时，hunk 操作会被隐藏，因为屏幕
上的 hunk 此时并不是会被应用的 hunk。`unstage_all` 把**整个索引**重置到
`HEAD`——包括窗口打开之前就已暂存的内容。

**冲突。** 索引冲突列表从 libgit2 读取；解决时写入文件，然后 `remove_path` +
`add_path`。`has_markers` 检查 `<<<<<<<`，以便界面区分未解决文件与已暂存
文件。

**Blame。** `file_blame` 拒绝超过 5 MiB 的文件和包含 NUL 字节的文件，接受
可选修订版本，并标记未提交的 hunk。

**Forge 提供方。** GitHub、GitLab 与 Bitbucket 实现在同一个 `forge` trait
之后。请求经由 `forge_request` 发出，它在白名单校验之后注入 keyring token：
GitHub 使用 Bearer 加 `application/vnd.github+json`，GitLab 使用
`private-token`，Bitbucket 使用 Basic `base64(email:token)`。拉取请求分区与
`pr_checkout` 就由它支撑。

**AI 审查。** 提交信息、差异说明与审查可以由 CLI agent（`claude`、`copilot`、
`codex`、`gemini`、`opencode`、`antigravity`、`cursor`）或 HTTP 提供方
（`openai`、`anthropic`、`gemini`、`ollama`、`lmstudio`）生成。默认 CLI 调用
是 `claude -p --output-format text`，提示词走 stdin，超时 240 秒（限制在
1–600），移除 ANSI。审查由基于排序后的 `[path, staged, unstaged]` 列表计算
的签名作废，因此过期审查不会被静默复用。

**撤销/重做与变基。** 影响分支的操作会被记录，工具栏的撤销可以恢复分支，
但仅限分支此后未移动的情况。交互式变基计划（pick / reword / squash /
fixup / drop）在前端编译，由引擎应用。

**签名。** 在签名配置上提交需要 `user.signingKey`；缺少密钥会报错，而不是
静默地无签名提交，签名器有 60 秒，超时提交失败。

## 限制

| 限制 | 取值 | 位置 |
| --- | --- | --- |
| 可编辑文件 | 5 MiB | `MAX_EDITABLE_BYTES` |
| Blame 源文件 | 5 MiB，无 NUL 字节 | `MAX_BLAME_BYTES` |
| 图片差异 | 10 MiB | `MAX_IMAGE_BYTES` |
| 渲染的差异行 | 5 000 个字符 | `MAX_RENDERED_LINE` |
| 历史分页 | 200 个提交 | `PAGE_SIZE` |
| 仓库扫描 | 深度 16，2 000 个结果 | `SCAN_MAX_DEPTH`、`SCAN_MAX_RESULTS` |
| 最近仓库 | 1 000 | `RECENT_LIMIT` |

扫描会跳过 `node_modules`、`target`、`vendor`、`dist`、`build`、`obj`、
`venv`、`Pods`、`Library`、`bower_components`、`__pycache__` 以及所有点目录。

**SSH 远程在本构建中不可用。** `git_engine_info` 在 Windows 上报告
`ssh: false`，因为 libgit2 未使用 vendored OpenSSL 构建；在这一点改变之前，
HTTPS 远程是受支持的路径。

## 将本模块接入其他应用

1. 在 `src-tauri/Cargo.toml` 中注册该 crate，并从 `invoke.rs` 暴露其命令。
2. 将每个命令加入 `build.rs` 的 `COMMANDS` 列表，并在
   `capabilities/default.json` 中授予 `allow-<command>`；把 `git-repo-*`
   加入能力配置的窗口列表。
3. 在 setup 期间设置 `git_core::accounts::CONFIG_DIR`，否则每个触及存储的
   命令都会失败。
4. 把 `git-repo` 路由对加入页面映射与侧边栏。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 窗口显示欢迎视图而不是仓库 | 缺少 `?path=`，或 `repo_open` 失败——toast 中带有原因 |
| 第二次点击打开第二个窗口 | 两个路径的规范化结果不同（大小写或末尾分隔符） |
| 其他工具所做的修改从不出现 | 监视器忽略 `objects/` 与 `*.lock`；用 `Ctrl+R` 重新加载 |
| 「取消暂存」移除了超出预期的内容 | `unstage_all` 把整个索引重置到 `HEAD` |
| hunk 与行级操作缺失 | 差异面板处于整文件或忽略空白模式 |
| fetch 或 push 因 `auth` 失败 | 没有 `acct:{host}:{username}` 的 keyring 条目，或 token 已过期 |
| forge 调用因 `forbidden` 或 `plan_limit` 失败 | token 作用域或 IP 白名单；`plan_limit` 是提供方侧的 402 |
| 提交提示 Git 身份未配置 | 仓库配置中未设置 `user.name` / `user.email` |
| 仅在开启签名时提交失败 | 缺少 `user.signingKey`，或签名器超过 60 秒 |
| 打开文件被拒绝 | 文件超过 5 MiB |
| AI 按钮被禁用 | 未配置提供方，或未检测到 CLI agent |
| AI 审查看起来已过期 | 暂存或未暂存内容发生变化——签名不再匹配 |
