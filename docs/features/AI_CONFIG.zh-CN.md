# AI 配置同步

**AI 配置同步**页面把同一个 git 仓库作为技能、规则、命令、子代理与 MCP 服务器
定义的唯一来源，并把这份存储翻译成各个 AI 编程代理期望的目录布局。它位于侧边栏
「Agent」分组。

编辑只在存储里做一次。随后每个代理会得到一个*计划*——将要写入与删除的文件——
并在任何写入发生之前展示出来。反方向同样成立：代理的本地文件也能被拉回存储。

引擎为 [`src-tauri/shaic-core`](../../src-tauri/shaic-core)，取自
[shaic](https://github.com/dariocurr/shaic) v0.3.0（MIT；见该 crate 的
`UPSTREAM.md`）。上游的 TUI 由 Tauri 命令层与本页面取代；存储、适配器与物化器
沿用的是上游逻辑。

## 存储

```
~/.shaic/store/                 # 一个 git 仓库；必须有 .git
├── .shaic-store.toml           # schema_version = 1
├── skills/<name>/SKILL.md
├── rules/<name>.md
├── commands/<name>.md
├── subagents/<name>.md
└── mcp/<name>.toml
```

每个条目都是一个 YAML frontmatter 加一段正文：

```yaml
---
name: fix-lint
description: …
applies_to: …
tags: []
scope: []
agents: []
tools: []
native: {}
---
```

机器本地状态位于存储之外，从不同步：

```
<config dir>/shaic/config.toml          # remote、enabled_agents、projects
~/.shaic/state/<agent>-<scope>.toml     # 每个代理的清单：path → whole:<sha> | region:<sha>
```

清单是页面判断上次写了什么的方式。只有文件内容仍与清单中记录的摘要一致时才会
删除它，这正是手工编辑安全的原因：页面会停止管理该文件，而不是覆盖这次编辑。

## 支持哪些代理，写到哪

| 标识 | 显示名 | 作用域 | 写入内容 |
| --- | --- | --- | --- |
| `claude-code` | Claude Code | 全局、项目 | `~/.claude` 或 `<project>/.claude` 下的 `skills/`、`commands/`、`CLAUDE.md`、`agents/` |
| `cursor` | Cursor | 项目 | `.cursor/rules/<n>.mdc`（或 `.cursorrules`）、`.cursor/agents/<n>.md` |
| `windsurf` | Windsurf | 项目 | `.windsurf/rules/<n>.md`（或 `.windsurfrules`）、`.windsurf/workflows/` |
| `copilot` | GitHub Copilot | 项目 | `.github/copilot-instructions.md`、`instructions/`、`prompts/` |
| `codex` | OpenAI Codex CLI | 全局、项目 | `~/.codex` 或 `.codex` 下的 `skills/`、`AGENTS.md`、`.codex/agents/*.toml` |
| `opencode` | OpenCode | 全局、项目 | `~/.config/opencode`、`AGENTS.md` |
| `gemini` | Google Gemini CLI | 全局、项目 | `GEMINI.md` |
| `cline` | Cline | 项目 | `.clinerules/` 或 `.clinerules` |
| `antigravity` | Google Antigravity | 项目 | 仅发现——实验性，只读 |

MCP 目标为 Claude（`.mcp.json`、`~/.claude.json`）、Cursor（`.cursor/mcp.json`）、
Windsurf（`~/.codeium/windsurf/mcp_config.json`）、Copilot（`.vscode/mcp.json`）、
Codex（`.codex/config.toml` 的 `[mcp_servers]`）与 OpenCode（`opencode.json`）。
Gemini、Cline 与 Antigravity 没有。

一个适配器声明自己的 id、显示名、支持的作用域与类型，一个
`root(scope, project_root)`——当该代理在某个作用域下没有位置时返回 `None`
（绝不猜测路径）——以及渲染器、发现函数，对单文件代理还有托管的区段。

**单文件目标是拼接而非替换。** 内容写在 `<!-- shaic:begin -->` 与
`<!-- shaic:end -->` 标记之间，内容里出现的任何标记都会被转义，因此拼接始终
可逆。这样用户同时手工编辑的 `CLAUDE.md` 或 `AGENTS.md` 才能保住其他区段。

## 漂移、计划、应用

```
page → shaic_dashboard()        one row per agent, worst state across scopes
     → shaic_agent_detail(a)    per scope, per axis (content, MCP)
     → shaic_plan(a, scope, mcp?)   read-only: writes, deletes, warnings
     → shaic_apply(a, scope, mcp?)  performs it
```

状态通过构建计划并观察它得出：

| 状态 | 含义 |
| --- | --- |
| `in-sync` | 计划为空——磁盘上的内容就是要写入的内容 |
| `drift` | 计划里有待做的工作 |
| `unconfirmed` | 无法检查该代理（只读或实验性适配器） |
| `error` | 构建计划失败 |

每行取其各轴中最差的状态：`error` > `drift` > `unconfirmed` > `in-sync`。在设置
中关闭的代理不会产生任何行。

应用时先写入、之后才删除；写入失败会留下未执行的删除。每次写入在 rename 之前
都会立即重新校验其路径，即使部分失败也会保存清单，好让下一次运行知道已存在什么。
没有 `.bak` 文件——存储与代理自己的版本控制就是恢复方案。

## 把代理拉回

`shaic_import_scope(agent, scope)` 读取代理的文件，解析成规范条目并保存到存储。
当磁盘格式承载不了 `description`、`tags`、`applies_to` 与 `agents` 时会保留它们，
跳过完全相同的条目，并拒绝覆盖已存在的子代理（界面从不请求强制覆盖）。导入
**不会**随即写回代理——计划与「应用」是分开的两步。

`shaic_pull` 与 `shaic_push` 是 git 一侧：pull 仅允许快进，存储有未提交改动时
拒绝；push 先 fetch 并以快进方式合并再推送；两者都不碰代理文件。

## 安全

- **路径守卫。** 不允许 `..`、不允许绝对路径覆盖、中间不允许符号链接，并且在
  每次创建目录与 rename 之前重新检查。
- **密钥扫描。** 针对 AWS/GitHub/OpenAI/Stripe/Google/Slack 密钥、JWT、私钥
  头、带凭据的 URL，以及通用的 `secret|token|password` 赋值，有一条正则绊线，
  在保存条目、保存 MCP、暂存推送差异和即将提交的范围上运行。命中会阻止操作，
  直到显式放行。
- **Frontmatter 限制。** 最大 64 KiB；YAML 锚点、别名与合并键在解析前即被拒绝。
- **密钥只是引用。** MCP 的 `EnvValue::Secret` 不持有值；值放在 OS 钥匙串中，
  服务名为 `shaic-mcp`。
- **git 以防御方式调用。** `env_clear`、`GIT_TERMINAL_PROMPT=0`、
  `BatchMode=yes`，远端 URL 只限 https/ssh/git/file/本地路径，且不得内嵌凭据。

## 命令

| 分组 | 命令 |
| --- | --- |
| 存储 | `shaic_status`、`shaic_init`、`shaic_push`、`shaic_pull` |
| 检查 | `shaic_dashboard`、`shaic_agent_detail` |
| 物化 | `shaic_plan`、`shaic_apply`、`shaic_import_scope` |
| 条目 | `shaic_list_items`、`shaic_item_template`、`shaic_item_source`、`shaic_save_item`、`shaic_remove_item` |

`shaic_remove_item` 是唯一会立即扩散到各代理的条目命令；其余的都等待计划与
「应用」。

## 限制

- Antigravity 仅支持发现。Gemini 只接收规则。Codex 的全局规则尽力而为。Cursor、
  Windsurf 与 Cline 并不覆盖每种类型。
- 若干代理仅支持项目作用域，因此它们没有全局行。
- 没有 MCP 编辑界面或命令——MCP 只作为计划中的一轴和存储中的内容出现，不是可
  编辑的表单。
- 条目名是单个路径片段；重命名意味着删除后重新添加。
- 两个条目可以渲染到同一路径（技能/规则塌缩、Cursor 代理遮蔽）；先者确定地
  胜出并给出警告。
- 项目作用域取决于「设置 → 项目」是否指向正确的工作副本。
- `git` 必须在 `PATH` 上。

## 把本模块接入其他应用

1. 把 `shaic-core` 加入 `src-tauri/Cargo.toml`，保留其 `UPSTREAM.md`，并通过
   `invoke.rs`、`build.rs` 与 `capabilities/default.json` 暴露命令。
2. 复制 `src/pages/ai-config` 以及 `shaic` 命令封装。
3. 添加 `aiConfig.enabledAgents` 设置（缺省表示所有代理启用）。
4. 把项目作用域指向新应用里「当前工作副本」的含义——该 crate 通过一个小设置钩子
   读取它。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 页面显示设置向导 | `~/.shaic/store` 没有 `.git`；初始化它 |
| "no remote configured" | 存储初始化时没有配置远端 |
| "initialize failed: RemoteAlreadySet" | 存储已有一个不同的 origin |
| 某个代理完全没有行 | 它已在设置中关闭 |
| 状态为 `unconfirmed` | 该代理是只读或实验性的 |
| 某个代理的应用被拒绝 | 该代理在设置中已关闭 |
| "path escapes" 或 "refusing to write through symlink" | 代理目录或存储条目是符号链接 |
| "potential secret detected: line N" | 密钥扫描命中；修正内容或有意放行 |
| "frontmatter contains a disallowed YAML anchor" | 锚点、别名与合并键被拒绝 |
| "has diverged from origin" | 本地与远端历史分叉；用普通 git 处理 |
| Pull 以 "uncommitted changes" 拒绝 | 先提交或丢弃存储的改动 |
| Pull 或「应用」没有改变磁盘 | Pull 只更新存储；需要再运行计划与「应用」 |
| 页面写过的文件从未被清理 | 清单丢失了——它退化为「什么都不能删」 |
