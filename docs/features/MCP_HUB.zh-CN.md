# MCP Hub

**MCP Hub** 页面把本机 MCP 服务器聚合到一个本地端点之后。它位于侧边栏「Agent」
分组，运行在主窗口内。

其意义在于：客户端（Claude Desktop、Cursor、Windsurf，任何支持 MCP 的东西）只需
连接一次，就能看到 hub 管理的每个服务器，只有一个列表用于开关服务器与工具，只有
一份日志，token 也只在一处管理。实现改编自
[McpHub](https://github.com/Soflutionltd/McpHub)（MIT）；上游的 HTML 面板由 Tauri
命令取代，服务器在本进程内运行，而不是独立的二进制。

## 端点

| 属性 | 取值 |
| --- | --- |
| 地址 | `127.0.0.1:24680` |
| 传输 | **仅 SSE** —— `GET /sse` 打开，`POST /message?sessionId=…` 发送 |
| 端点帧 | 第一个 SSE 事件是 `endpoint` → `/message?sessionId=<id>` |
| 保活 | 每 15 秒一条注释 |
| 空闲会话 | 300 秒后回收（每 60 秒检查） |
| 其他一切 | 404 —— 没有 `/`，没有 `/api/*`，没有静态文件 |
| `OPTIONS` | 204，宽松的 CORS |

没有 streamable-HTTP（`/mcp`）传输；`mcphub_endpoint_info` 通过
`stdioAvailable: false` 表明这一点。绑定失败时间隔 200 ms 重试五次才上报失败，
这足以覆盖仍处于 `TIME_WAIT` 的端口。

客户端按类型 "SSE"、URL `http://127.0.0.1:24680/sse` 配置。

## 认证

Token 保存在 `<data dir>/.mcphub/tokens.json`：

```json
{ "tokens": { "mcphub_<uuid>": { "name": "laptop", "allowed_servers": [], "created_at": 0 } } }
```

- **全新安装、没有任何 token 时是开放的。** 一旦存在一个 token，每个请求都需要
  `Authorization: Bearer mcphub_<uuid>`，未认证的客户端得到 401。
- `.mcphub/auth-token` 处的旧式单 token 仍然有效，在 Unix 上会以 mode 600 自动
  创建。
- `allowed_servers` 会被保存并显示，但**不强制执行** —— 一个 token 可以调用任何
  服务器。

## 工具调用如何流转

```
client ── POST /message ──▶ ProxyServer::handle_request
            → tools/call
               reject disabled server → reject disabled tool
               → execute cache (60 s)
               → ChildManager::call_tool
                    lazily start the server's pool, round-robin instances
                    retry once on a transport error
               → metrics, cache, JSON-RPC result
```

有两种暴露模式：

| 模式 | 行为 |
| --- | --- |
| `discover`（默认） | 只有两个元工具：`discover(query, server?, top_k?)` 与 `execute(server, tool, arguments)`。BM25 索引（k1 1.2，b 0.75）对工具排序；top_k 默认 10，最大 50 |
| `passthrough` | 每个工具直接暴露，命名为 `server__tool` |

工具名以双下划线作命名空间，冲突也以同样方式解决。因此自身含有 `__` 的服务器
或工具名会路由错误——这是运维者必须遵守的唯一命名规则。

## 子服务器

一个服务器条目是一条 stdio 命令：

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "env": {}, "pool": 2, "disabled": false, "requestTimeoutSecs": 180 }
```

- 以管道化的 stdin/stdout/stderr 启动，环境为父进程环境加上 `env`，Windows 上
  当命令是 `.cmd` shim 时经由 `cmd /C`。
- **无法设置工作目录。** 解析相对路径的子进程拿到的是应用的工作目录。
- `pool` 表示运行多少个实例并轮询分配；为 1 时省略。
- 握手：`initialize`（协议 `2024-11-05`）→ `notifications/initialized` →
  `tools/list`，以 500/1000/2000 ms 退避重试三次。
- Windows 上以 `taskkill /PID … /T /F` 终止。

健康监视每 30 秒 ping 一次，超时 5 秒，最多以 2/4/8 秒退避重启三次，可在设置中
关闭。注意服务器的「healthy」标记意思是*自启动以来未记录错误*，而不是「进程正在
运行」——`running` 是另一个字段。

| 超时 | 取值 |
| --- | --- |
| 请求（全局默认） | 120 秒，可按服务器覆盖，或用 `MCPHUB_REQUEST_TIMEOUT_SECS` 覆盖 |
| 引导（`initialize`、`tools/list`） | 60 秒 |
| 健康 ping | 5 秒 |
| 执行缓存 / 发现缓存 | 60 秒 / 30 秒 |

## 配置

```
<data dir>/.mcphub/
├── config.json          # { mcpServers, settings, toolEnabled }
├── tokens.json
├── schema-cache.json    # 每个服务器最近已知的工具列表
├── auth-token           # 旧式单 token
└── logs/mcphub.log
```

`config.json` 不存在时，hub 会从机器上能找到的 MCP 配置文件导入服务器——
`~/.cursor/mcp.json`、`~/.codeium/windsurf/mcp_config.json`、`~/.vscode/mcp.json`，
以及 macOS 上 Claude Desktop 的配置。名字看起来像 hub 自身的条目会被跳过，以免
hub 把自己拉进来。

## 日志与指标

子进程的 stderr 与 MCP `notifications/message` 进入 1 000 条的内存环形缓冲，并以
JSON 行写入 `logs/mcphub.log`。**轮转即截断**：文件超过 5 MiB 时被删除并重新开始，
因此没有带编号的历史可供回溯。

指标保存在内存中，随网关一起重置：总请求数、活动会话数、运行时长，以及每个服务器
的请求数、错误数、平均延迟与最后调用时间。界面轮询；hub 不发事件。

## 命令

| 分组 | 命令 |
| --- | --- |
| 生命周期 | `mcphub_start`、`mcphub_stop`、`mcphub_status`、`mcphub_endpoint_info` |
| 服务器 | `mcphub_list_servers`、`mcphub_add_server`、`mcphub_update_server`、`mcphub_remove_server`、`mcphub_set_server_enabled`、`mcphub_import_servers` |
| 工具 | `mcphub_list_tools`、`mcphub_set_tool_enabled`、`mcphub_regenerate_cache` |
| 设置 | `mcphub_get_settings`、`mcphub_update_settings`、`mcphub_set_mode` |
| Token | `mcphub_list_tokens`、`mcphub_create_token`、`mcphub_revoke_token` |
| 可观测性 | `mcphub_recent_logs`、`mcphub_metrics` |

网关**不会**自动启动；启动它才让端点生效，应用退出钩子会停止它。

## 限制

- 仅 SSE，一个端点，一个端口。同一台机器上的第二个实例无法绑定 24680。
- 服务器没有 `cwd`，不做 shell 环境探测，没有按服务器的标签。
- `allowed_servers` 不强制执行。
- 日志是单个会被截断的文件，没有归档。
- 指标不跨重启保留。

## 把本模块接入其他应用

1. 添加 `src-tauri/src/mcphub`，并从 `invoke.rs`、`build.rs` 和
   `capabilities/default.json` 暴露其命令。
2. 复制 `src/pages/mcp-hub` —— 它用轮询，不需要接事件。
3. 数据目录通过 `config::dir()` 解析；hub 自己创建 `.mcphub`。
4. 如果也移植了 Claude 对话，它可以把 hub 已启用的服务器作为 `--mcp-config`
   传入。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 出现 "Failed to bind 127.0.0.1:24680" | 另一个进程——通常是旧实例——占着端口 |
| 客户端得到 401 | 已存在 token，而客户端没发或发错 |
| `discover` 返回加载占位符 | 索引尚未预热；子进程仍在启动，或三次尝试后失败 |
| `-32602 Invalid tool name format` | 透传名不含 `__`，或服务器/工具名中含 `__` |
| 服务器显示为禁用，尽管已启用 | 条目中仍有 `disabled: true` |
| 修改 `config.json` 后列出的工具不出现 | 缓存未重新生成 |
| 子进程找不到相对路径的文件 | 没有 `cwd` 选项；它继承了应用的目录 |
| 日志消失 | 5 MiB 的截断删掉了文件 |
