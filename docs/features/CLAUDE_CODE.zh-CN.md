# Claude

侧边栏「Agent」分组下有三个页面用于 Claude Code：**Claude 对话**（聊天）、
**Claude 历史**（历史）和 **Claude 工作流**（工作流）。三者都不单独开窗口，
都是主窗口页面。

三者的分工：**对话**驱动本机安装的 `claude` CLI，产生真实会话；**历史**读取
Claude Code 已经保存的会话，并从中派生出新会话（克隆、分叉）；**工作流**把
历史创建的家族树画出来。

聊天行为移植自
[jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)
（MIT），转录钩子取自 [use-claude](https://github.com/ekaone/use-claude)
（MIT）。任何地方都没有 SDK 调用：一切都走本机已安装的 CLI。

## Claude 对话

```
useClaudeCode()  (src/lib/use-claude)
  └─ ClaudeSession ── invoke ──▶ claude_chat commands
       └─ StateManager   event "claude-event" (one NDJSON line) → transcript items
                         event "claude-log"   (spawn | in | out | err | sys)
                         event "claude-done"  (process exited)

stdin  ◀── {"type":"user", …}          per turn
stdout ──▶ one event per line          stream-json
control_request ──▶ ask dialog ──▶ respond_claude_control ──▶ stdin
```

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `send_to_claude` | `prompt`、`cwd`、`model`、`resume`、`permissionMode` | —（流式） |
| `interrupt_claude` | — | 有回合在运行时返回 `true` |
| `respond_claude_control` | `requestId`、`response` | — |

CLI 的启动参数为：

```
--print --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --permission-prompts host --permission-prompt-tool stdio
[--model <id>] [--permission-mode <manual|acceptEdits|auto|dontAsk|plan|bypassPermissions>]
[--mcp-config <data dir>/claude-mcp.json]   # 仅启用的 MCP Hub 服务器
[--resume <sessionId>]
```

提示词走 **stdin**，绝不放进 argv。从不使用 `--continue`：CLI 的 `system`/`init`
事件里的会话 id 会被记住，并在下一回合作为 `--resume` 传回，这正是让一次对话
保持连贯的原因。

流解析把 `stream_event` 增量变成实时文本、思考与工具卡片，并在回合结束时与
权威的 `assistant`、`user` 事件对齐。`result` 事件补上收尾条目，含时长与费用。
需要权限的工具调用以 `control_request` 到达，它会阻塞在内联对话框上并通过
stdin 回答。无人回答的提示在 120 秒后自动回答，回合因此不会永久挂起。

**一次只跑一个回合。** 只有一个运行槽；占用时发送会返回
"A Claude turn is already running."。停止是 Esc，它会杀掉整个进程树（Windows
上是 `taskkill /T /F`）。

工作目录默认取「设置 → 项目」中的工作副本，可在工具栏中修改，修改后会开始一段
新对话。转录抽屉可重新打开更早的会话；CLI 日志抽屉显示原始流量。

## Claude 历史

只读浏览 Claude Code 自己保存的内容——
`%USERPROFILE%\.claude\projects\<slug>\<sessionId>.jsonl`，slug 是工作目录中每个
非字母数字字符替换为 `-` 的结果（`M:\dev\app` → `M--dev-app`）。子代理转录
（`agent-*.jsonl`）、`journal.jsonl` 与 side-chain 文件被排除。

| 命令 | 返回 |
| --- | --- |
| `list_claude_projects` | 带会话数的项目 |
| `list_claude_project_sessions` | 单个项目的会话 |
| `load_claude_project_session` | 记录、分支、元数据 |
| `list_claude_sessions`、`load_claude_session` | 同上，限定在一个工作目录 |
| `clone_claude_session` | 新会话 id——每条记录都复制 |
| `fork_claude_session` | 新会话 id——复制到选定的消息为止 |
| `list_claude_families`、`load_claude_family` | 工作流页面用的克隆/分叉树 |
| `save_text_file` | Markdown 导出 |

会话可以以节点视图打开——每条消息一张卡片，工具与思考次数折叠在内——也可以以
完整转录打开，工具调用可折叠。

**克隆与分叉是仅有的写操作**，且从不改动已有文件：新会话先写到临时文件名，再
改名就位，保留原有的 `uuid`/`parentUuid`，只替换 `sessionId`。末尾一行
`custom-title` 携带标题。

分叉会复制到所选消息（含该条）为止的对话链，外加紧随其后的工具结果行——缺了
这些，API 会看到一个无人回答的工具调用。已不在链上的消息（例如压缩之后）无法
分叉。

## Claude 工作流

侧轨列出拥有克隆或分叉的会话；画布绘制家族：每回合一个节点（你的问题加上该回合
最后的回复），自上而下，每个叶子一列。分叉在其分叉点之前并入来源行，之后分离；
克隆另起一行；从克隆取得的分叉挂在该行之下。空的分叉仍会得到一个节点，因此
创建了却从未使用的分支是可见的，而不是无声缺失。

回合在后端配对（`turns_of`）：每条用户消息与下一条用户消息之前最后的助手文本
配对，截断到 600 个字符，取最新 500 个回合。

## 数据布局

```
%USERPROFILE%/.claude/projects/<slug>/<sessionId>.jsonl    # Claude Code 自身存储 —— 只读
<data dir>/.claude-history/forks/<rootSessionId>-fork.json  # 本应用的谱系记录
```

谱系文件为 `{ rootSessionId, rootProject, copies: [{ kind, sessionId, title,
project, sourceProject, sourceSessionId, forkUuid?, createdMs }] }`。它是尽力而为
的：文件缺失或不可读时工作流页面什么都不显示，但会话本身不受影响。在父会话上
追加 `custom-title` 是本模块中唯一的非原子写入。

## 限制

| 限制 | 取值 |
| --- | --- |
| 载入的转录行 | 最新 2 000 条记录 / 20 000 行 |
| 首尾扫描窗口 | 64 KiB |
| 工作流回合 | 500 个，每个 600 字符 |
| 初始显示的回合 | 3 个，每次「加载更早」+5 |
| CLI 日志抽屉 | 300 条 × 8 000 字符 |
| 权限对话框 | 120 秒后自动回答 |
| 画布缩放 | 0.2–1.6 |

聊天本身不存任何东西：对话保存在 Claude Code 的 JSONL 里，因此在这里启动的会话
与在终端启动的会话无法区分。

## 把本模块接入其他应用

1. 添加 `commands/claude_chat.rs`、`claude_history.rs` 与 `claude_fork.rs`，并
   在 `invoke.rs`、`build.rs` 和 `capabilities/default.json` 中注册全部十二个
   命令。
2. `claude` 二进制从 `PATH` 解析（Windows 上还看 `PATHEXT`，因此 `.cmd` shim 会
   经由 `cmd /C` 运行）。不必配置其他东西。
3. 连同署名头一起复制 `src/lib/use-claude`，以及三个页面。
4. 如果也移植了 MCP Hub，把 `--mcp-config` 指向它导出的配置；否则去掉该参数。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 出现 "Could not start claude…" | CLI 不在 `PATH` 上，或 `.cmd` shim 无法运行 |
| 历史列表为空但会话存在 | 工作目录 slug 不同——会话记录在别处 |
| 出现 "A Claude turn is already running." | 上一个回合仍在运行；中断它 |
| 只有工具卡片，没有文本 | 该 CLI 构建忽略了 `--include-partial-messages`；只有最终的 `assistant` 事件到达 |
| 权限对话框一直不关 | 无人回答，且 stdin 已经关闭 |
| 分叉失败并提示 "not part of this session's conversation" | 该消息已不在链上（压缩或回退） |
| 工作流页面为空 | 没有谱系文件——本应用还没有克隆或分叉过任何会话 |
| 会话没有标题 | 它没有 `customTitle`、`aiTitle`、`lastPrompt` 或首条提示 |
| `--resume` 失败 | 保存的会话 id 属于另一个工作目录 |
