# FRP 控制台

**FRP 控制台**页面用于管理本机的 `frpc` 客户端。侧边栏里它落在「其他」分组，
一个页面内含五个标签：概览、服务器、隧道、日志、运行时。它负责 `frpc` 的完整
生命周期：为每个服务器生成 TOML 配置、校验配置、启动子进程、监视进程，并把
输出实时送回页面。

进程管理、TOML 生成、运行时发现与日志处理移植自
[frpilot](../../THIRD_PARTY_NOTICES.md)（MIT）。本移植沿用其他模块的 JSON 存储
方式：不使用 SQLite、不使用 keyring、不内置下载器。

## 前置条件

- 一个可连接的 `frps`（FRP 服务端）。
- 本机的 `frpc` 可执行文件。应用不会下载它，可以手动导入路径，或让扫描自动
  发现。

## 运行时

一条运行时记录对应一个 `frpc` 二进制：绝对路径、探测到的版本、平台与架构、
文件大小，以及可用的 SHA-256。

| 操作 | 行为 |
| --- | --- |
| 导入 | 选择文件后用 `frpc --version` 探测；探测成功才会写入记录。 |
| 本机发现 | 扫描 `PATH`、常见安装目录（`Program Files`、`FRP`、包管理器目录等），以及按需对主目录做有限深度的浅层扫描；已导入的候选会被标记。 |
| 删除 | 只删除记录，磁盘上的二进制不动。被服务器档案引用、或该运行时正在运行时拒绝删除。 |

档案有两种运行时选择方式：

- **推荐** —— 绑定的运行时仍存在时优先使用它，否则使用当前平台最新的兼容
  运行时。因此新导入的版本可能改变档案实际使用的二进制。
- **固定** —— 指定某条运行时记录。记录消失或文件被移动/删除时启动直接返回
  `runtime-missing`。

`frpc verify` 与实际启动使用同一套解析逻辑，不会出现「校验用的 A、运行用的 B」。

## 服务器（档案）

一个档案对应一条 `frps` 连接：地址、端口、可选 Token、运行时策略、重连开关和
备注。每个档案独占一个 `frpc` 子进程，启动某一个不会影响其他档案。

- Token 明文保存在数据目录中（与服务器管理模块一致），界面默认掩码、可显隐，
  配置预览与 verify 输出中会被替换为 `***`。
- 任何影响生成配置的修改都会递增 `configRevision`；运行中的档案随后显示
  「需重启」，直到手动重启。
- 删除档案时先停止子进程，再级联删除其隧道、生成的配置、pid 记录与日志目录。

## 隧道

隧道属于某个档案，必有名称、启用开关、本地地址（`localIp` + `localPort`）以及
与类型匹配的 options：

| 类型 | options 形态 | 必填字段 |
| --- | --- | --- |
| `tcp`、`udp` | `port` | `remotePort`（1–65535） |
| `http`、`https` | `domain` | `customDomains` / `subdomain` 至少填一个；`locations` 可选 |
| `stcp`、`xtcp` | `secret` | `secretKey`；`role`（`server` 或 `visitor`）；visitor 还需 `serverName` |

options 形态必须与类型匹配：表单、存储层与 TOML 生成共用同一个归一化函数，
非法组合在交给 `frpc` 之前就会被拒绝。隧道名在同一档案内唯一，重名返回
`conflict`。

## 配置生成

结构化表单是唯一数据源，`profiles/<profileId>/frpc.toml` 只是运行产物，每次启动
重新生成：

1. 短锁：拷贝档案、隧道与运行时记录；
2. 释放锁：渲染 TOML 并执行 `frpc verify -c <path>`（20 秒超时）；
3. 再次短锁：确认档案仍存在，写入最终配置，必要时递增 revision；
4. 释放锁：启动进程。

预览面板复用同一个校验；预览与校验输出都会脱敏（`auth.token`、隧道
`secretKey`）。

## 进程监视

一个档案一个子进程，由独立的进程表管理，所有事件都在锁外发送。

| 行为 | 取值 |
| --- | --- |
| 停止 | 先优雅终止，5 秒后强制结束 |
| 重连退避 | 1 秒、2 秒、4 秒……最多 60 秒（仅在开启重连时） |
| 熔断 | 连续 5 次崩溃后停止该档案；连续运行满 30 秒会重置计数 |
| 崩溃判定 | 只有启动后 15 秒内退出才算崩溃 |
| 延迟 | 到服务端的 TCP 握手耗时，每 2 秒上报一次 |
| 健康检查 | 45 秒宽限期后每 15 秒做一次重启判定；连续 2 次失败才重启 |
| 休眠/唤醒 | 墙钟间隔 ≥30 秒视为休眠或断网，立即探测，失败 1 次即重启 |
| 永久失败 | 认证/配置类错误（`login to server failed`、`authorization failed`、`token rejected`、文件不存在、权限不足等）不再重试，直接置为 failed |

前端通过三个事件同步状态：`frp:state`（仅状态变化）、`frp:metrics`（每 2 秒的
延迟与隧道状态）、`frp:log`；另有连接列表轮询兜底。

应用启动时会依据 `profiles/<profileId>/frpc.pid` 清理上次遗留的 `frpc` 进程并
删除对应的 pid 记录；应用退出时停止所有受管子进程。

## 日志

每一行输出都会带流（`stdout` / `stderr`）、推断出的级别与时间戳，然后：

- 进入每个档案 400 行的内存环形缓冲（供 `frp_logs_recent` 使用）；
- 通过 `frp:log` 推送到页面，页面维护 2,000 行缓冲，只有日志标签订阅；
- 追加写入 `logs/<profileId>/frpc.YYYYMMDD.log`。

文件超过 `logMaxFileSizeMb`（默认 20 MB）时轮转为
`frpc.<day>.part.<stamp>.log`，并按 `logRetentionDays`（默认 7 天）和
`logMaxFilesPerProfile`（默认 5 个）清理。界面上的「清空」只清内存缓冲，磁盘
文件保留。

## 数据目录

所有数据都在应用数据目录的 `frp/` 下（数据目录可在设置中修改，修改后需重启）：

```
<data dir>/frp/
├── frp.json                        # 档案、隧道、运行时、偏好
├── frp.json.bak-<unix>             # 仅在损坏文件被替换时出现
├── profiles/
│   └── <profileId>/
│       ├── frpc.toml               # 每次启动重新生成
│       └── frpc.pid                # 运行中子进程的 pid，用于清理残留
└── logs/
    └── <profileId>/
        └── frpc.YYYYMMDD.log
```

`frp.json` 采用临时文件 + rename 原子写入；无法解析的文件会被改名为
`frp.json.bak-<unix>` 后用空工作区继续，页面不会因此打不开。

Token 与隧道密钥是明文存储，请把该目录视为敏感数据：不要提交到仓库，也不要
放进公开同步目录。

## 命令

全部命令以 `frp_` 为前缀，并在 `invoke.rs`、`build.rs` 与
`capabilities/default.json` 三处同名注册。

| 分组 | 命令 |
| --- | --- |
| 档案 | `frp_profiles_list`、`frp_profile_create`、`frp_profile_update`、`frp_profile_delete`、`frp_profile_reorder` |
| 隧道 | `frp_tunnels_list`、`frp_tunnel_create`、`frp_tunnel_update`、`frp_tunnel_delete` |
| 运行时 | `frp_runtimes_list`、`frp_runtime_probe`、`frp_runtime_import`、`frp_runtime_delete`、`frp_runtimes_discover` |
| 生命周期 | `frp_start`、`frp_stop`、`frp_restart`、`frp_start_all`、`frp_stop_all`、`frp_connections_list`、`frp_nudge_health` |
| 配置 | `frp_config_preview`、`frp_config_verify` |
| 日志 | `frp_logs_recent`、`frp_logs_clear` |

错误统一序列化为 `{ code, message, detail? }`，`code` 取值：`not-found`、
`invalid-input`、`conflict`、`runtime-missing`、`runtime-in-use`、
`config-invalid`、`spawn-failed`、`not-implemented`、`internal`。页面把错误码
映射为 i18n 文案，并在其后附上引擎的原始消息。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 启动返回 `runtime-missing` | 没有可用运行时，或固定绑定的二进制被移动/删除。到运行时标签重新导入。 |
| 启动返回 `config-invalid` | `frpc verify` 拒绝了生成的 TOML，查看预览里的校验输出。 |
| 档案立刻变成 failed | 命中了永久失败（Token 被拒、认证失败等），先修 Token，重试没有意义。 |
| 重试几次后档案停止 | 连续 5 次崩溃触发熔断，去日志里找根因。 |
| 删除运行时被拒绝 | 有档案引用它，或使用它的档案正在运行。 |
| 进程在跑但隧道显示离线 | 服务端尚未回 `start proxy success`，看日志标签确认。 |
