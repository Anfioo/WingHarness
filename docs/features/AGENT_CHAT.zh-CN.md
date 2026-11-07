# Agent 对话

**Agent 对话**是「Agent」分组下的主窗口页面。它在一个页面里与本机的
Claude Code、Codex、Qoder 三个编码 CLI 对话：每个标签是一个独立会话，
回复以流式返回，工具调用、思考过程、提问与权限请求都在同一条时间线上处理。
侧栏列出各 CLI 已经保存在磁盘上的原生会话。

本页移植自
[desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
（`ccgui-next` 1.2.2，MIT）。引擎与历史层位于 `src-tauri/agent-chat-core`
crate，移植文件保留署名头；React 前端按本仓的组件体系重写。任何地方都不调用
SDK：所有请求都走本机已安装的 CLI。

## 页面结构

```
┌─ 侧栏 ───────────┬─ 标签条 ─────────────────────────────┐
│ 搜索 / 新建      │ Claude │ Codex │ +                   │
│ 今天             ├──────────────────────────────────────┤
│ 昨天             │ 时间线（虚拟列表）                   │
│ 更早             │   用户 · 助手 · 思考                 │
│                  │   工具 · 提问 · 授权 · 错误          │
│                  ├──────────────────────────────────────┤
│                  │ 输入区：引擎 模型 权限 工作目录      │
└──────────────────┴──────────────────────────────────────┘
```

- **侧栏**——会话按「今天 / 昨天 / 更早」分组，带搜索框与刷新按钮。点击一行
  会在新标签中打开该会话。
- **标签**——每个标签是一个独立会话，以本地 `tabId` 为键（不是原生会话 id）。
  最多 8 个标签。关闭标签会先中断该会话的运行。下次启动时恢复活动标签、打开的
  标签与各引擎偏好。
- **时间线**——用户、助手、思考、工具、提问、授权与错误行的虚拟列表。思考块与
  工具卡可折叠；视图默认跟随最新一行，用户向上滚动后停止跟随，并显示「回到
  底部」按钮。首屏加载 200 条消息；「加载更早」向后端请求上一页。
- **输入区**——引擎、模型、权限与工作目录控件，以及提示词输入框。Enter 发送，
  Shift+Enter 换行；有运行中的回合时发送按钮变为停止。只有在标签仍为空（没有
  消息）时才允许原地切换引擎；已有对话时切换引擎会新开标签。修改工作目录也是
  同样行为。

## 三个引擎

### Claude Code

| 方面 | 取值 |
| --- | --- |
| 传输方式 | `child`——每个回合一个 `claude -p` 进程，逐行输出 `stream-json` |
| 可执行文件 | 从 `PATH` 解析 `claude`（Windows 上兼顾 `PATHEXT`，npm 生成的 `.cmd`/`.ps1` 包装经 `cmd /C` 运行） |
| 会话文件 | `<home>/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl`；`CLAUDE_CONFIG_DIR` 可覆盖 `<home>/.claude` |
| 提问通道 | CLI 通过 stdin 发出 `control_request`；回答以 `control_response` 写回。`AskUserQuestion` 渲染为提问卡 |

启动参数为 `--print --input-format stream-json --output-format stream-json
--verbose --include-partial-messages`，外加 `--permission-prompt-tool stdio`、
选定的 `--permission-mode`，以及已知原生会话 id 后的 `--resume <sessionId>`。
提示词写在 stdin，绝不放进 argv。权限模式：`auto`、`manual`、`plan`、`bypass`。

### Codex

| 方面 | 取值 |
| --- | --- |
| 传输方式 | `own`——每个回合一个 `codex app-server` 子进程，用 stdio 上的 JSON-RPC 通信（`initialize` → `thread/new` 或 `thread/resume` → `turn/start`） |
| 可执行文件 | 从 `PATH`/`PATHEXT` 解析 `codex` |
| 会话文件 | `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，另含 `archived_sessions`；`CODEX_HOME` 可覆盖 `<home>/.codex` |
| 提问通道 | app-server 的 `item/tool/requestUserInput` 通知 → 提问卡 → `agent_answer` 写入应答帧；在作答前回合保持挂起 |

不使用 `codex exec`。推理强度以 `-c model_reasoning_effort=…` 传入。权限模式：
`auto`、`manual`、`bypass`。

### Qoder

| 方面 | 取值 |
| --- | --- |
| 传输方式 | `own`——每个回合一个 `qodercli --acp` 子进程，使用 Agent Client Protocol（stdio 上的 JSON-RPC） |
| 可执行文件 | `qodercli`（`qoder` 是 IDE 启动器，不支持 ACP） |
| 会话文件 | 无——不扫描 ACP 会话；历史列表只覆盖 Claude 与 Codex |
| 提问通道 | 无——无头 ACP 回合以 bypass 启动，任何 `session/request_permission` 都会被自动放行 |

驱动按 `initialize` → `session/new` 或 `session/resume` → 可选的
`session/set_model` 与 `session/set_config_option` → `session/prompt` 握手。
只上报 `bypass` 一种权限模式，因为无头模式无法履行其他模式。CN 发行版
（`qoderclicn`、`~/.qoder-cn`）共用同一驱动，但尚未注册为引擎。

## 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `agent_list_engines` | — | `AgentEngineInfo[]`——名称、可用性、可执行文件、权限、传输方式 |
| `agent_send` | `input: AgentSendInput` | `AgentSendResult { runId, sessionId? }` |
| `agent_interrupt` | `runId` | 杀掉存活回合时返回 `true` |
| `agent_live_runs` | `runIds: string[]` | 仍然存活的子集 |
| `agent_answer` | `runId`、`requestId`、`answers: Value \| null` | — |
| `agent_list_sessions` | `engine?`、`workspacePath?`、`limit?` | `AgentSessionMeta[]` |
| `agent_load_session` | `engine`、`sessionId`、`workspacePath`、`limit?`、`beforeSeq?` | `AgentSessionPage { messages, nextBefore }` |
| `agent_ui_get` | — | `AgentUiState` |
| `agent_ui_set` | `state: AgentUiState` | — |

`AgentSendInput` 包含 `engine`、`workspacePath`、`prompt`，可选 `sessionId`、
`model`、`effort`、`permission`、`additionalDirs`（Claude 的 `--add-dir`）以及
前端预生成的 `runId`。后端在占用运行名额之前就会拒绝空提示词、不存在的工作
目录、未知引擎与未安装的 CLI。

## 事件

只有一个事件通道 `agent:event`，payload 是事件 **JSON 数组**。后端按最多
16 ms 或 64 KiB 批量发送，因此一个流式回合每帧只花一条 IPC 消息，而不是每个
token 一条。

| 字段 | 含义 |
| --- | --- |
| `runId` | 把事件路由到发起该运行的标签 |
| `sessionId` | 原生会话 id，已知后才有；此前为 `null` |
| `engine` | `claude` \| `codex` \| `qoder` |
| `seq` | 每个运行单调递增；`done` 之后到达的事件会被页面丢弃 |
| `kind` | 下面十六种之一 |
| `data` | 与 kind 相关的载荷 |
| `ts` | 发送时的 Unix 毫秒时间戳 |

| `kind` | `data` |
| --- | --- |
| `delta` / `thinking` / `warn` | `string` |
| `message` | `{ role, text, path?, args?, result?, toolCallId?, patch? }` |
| `session` | 原生会话 id（`string`） |
| `usage` | 引擎原始 usage 对象（只存不渲染） |
| `model` / `effort` | `string` |
| `retry` | `{ attempt, max, message }` |
| `compaction` | `{ active, reason }` |
| `permission_denied` | `{ tool?, path?, message, toolUseId? }` |
| `question` | `{ requestId, toolUseId?, input }` |
| `question_settled` | `{ requestId }` |
| `error` | `string` |
| `done` | `{ usage?, sessionId? }` |
| `turn_resumed` | `null` |

所有失败都序列化为 `AgentChatError`：`{ code, message, detail? }`，`code` 为
kebab-case：`not-found`、`invalid-input`、`engine-unavailable`、`not-running`、
`conflict`、`unsupported`、`internal`、`not-implemented`。页面按 code 映射
i18n 文案；`message` 只作兜底。

## 数据布局

```
<data dir>/agent-chat/ui.json                 # 标签、活动标签、偏好、授权、最近工作目录
<data dir>/agent-chat/ui.json.bak-<unix>      # 无法读取的 ui.json 的副本
<home>/.claude/projects/<编码后的 cwd>/<id>.jsonl   # Claude Code 自己的存储——只读
<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  # Codex 自己的存储——只读
```

`ui.json` 以原子方式写入（临时文件、`sync_all`、重命名）。无法解析的文件会被
另存为 `ui.json.bak-<Unix 秒>`，页面从默认值启动。打开的标签裁剪到 20 个，
最近工作目录裁剪到 10 个并去重。不使用 `localStorage`。

历史只读。发现阶段只枚举候选 JSONL 文件并查看文件头；摘要按
`(path, size, mtime)` 缓存在进程内，未变化的文件不会重复解析。会话内容按页
向前读取：页面返回最新的 `limit` 条消息以及 `nextBefore = first.seq - 1`，
下一次调用把它作为 `beforeSeq` 传入。

## 限制

| 限制 | 取值 |
| --- | --- |
| 并发运行 | 3——第 4 次发送返回 `conflict` |
| 每页标签 | 8 |
| `ui.json` 持久化的标签 | 20 |
| 最近工作目录 | 10 |
| 每次扫描的会话 | 默认 200，最多 1 000 |
| 每页消息 | 默认 200，最多 2 000 |
| 单个会话文件读取 | 64 MiB / 200 000 行 |
| 摘要缓存 | 2 048 条 |
| 事件批量 | 16 ms / 64 KiB |

## 与 Claude 三页的关系

现有的 **Claude 对话**、**Claude 历史**与 **Claude 工作流**三个页面继续保留。
Agent 对话是一个独立的多引擎页面，既不替代也不扩展它们：它不克隆或分叉会话，
不写入 Claude 的存储，也不绘制工作流家族树。两个页面都以只读方式读取同一批
Claude JSONL 文件，因此在任一页面开始的对话都会出现在另一页面中。

## 排障

| 现象 | 可能原因 |
| --- | --- |
| 引擎显示「未安装」 | 它的 CLI 不在 `PATH` 上。安装后刷新（`npm install -g @anthropic-ai/claude-code`、`npm install -g @openai/codex`、`npm install -g @qoder-ai/qodercli`） |
| 会话列表为空 | CLI 的 home 下没有会话，或 CLI 使用了非默认 home。`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 会被识别；不扫描 Qoder 会话 |
| 提问卡始终不出现 | Qoder 以无头模式运行且自动放行权限；较旧的 Codex app-server 可能不发 `requestUserInput`；Claude 的非 `AskUserQuestion` 请求会变成权限拒绝卡 |
| 第 4 个并行发送被拒绝 | 并发上限为 3，先停止一个运行 |
| 「授权并重试」后目录仍不可写 | 只有 Claude 使用已授权的目录（`additionalDirs` / `--add-dir`） |
| 重启后标签丢失 | `ui.json` 损坏或会话文件无法读取；查看数据目录下的 `ui.json.bak-*` |
| 关闭应用后仍有引擎进程 | 不应发生：`RunEvent::Exit` 会杀掉所有存活运行，关闭标签也会中断其运行。若出现，请记录命令行并上报 |
