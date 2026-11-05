# 服务器管理

**服务器管理**页面是一个 SSH/SFTP 客户端。它位于侧边栏「其他」分组：选择器列出
档案与最近连接，每台服务器都在同一个共享窗口内以**标签页**打开，而不是各占一个
窗口。

本模块改编自 [XTerm](https://github.com/rockytkg/XTerm)（MIT），引擎为
[`src-tauri/server-core`](../../src-tauri/server-core)，构建在 `russh` 之上——纯
Rust，不依赖系统 libssh，也不依赖 OpenSSL。

## 窗口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/servers` | 选择器：档案、状态、最近连接 |
| `/server-window` | 管理窗口（label 为 `server-manager`），任意数量的服务器标签页 |

`openServerWindow(profileId)` 会聚焦已有窗口并向它发送 `server-open-profile`，
而不是再创建一个。首次创建时档案 id 通过 `?profile=` 传入；此后标签由事件打开。
每个服务器标签页有三个视图——「终端」（Terminal）、「XFTP」与「监控」
（Metrics）——终端视图里每个 shell 一个子标签。

关闭标签页会调用 `server_connection_close`；关闭窗口会先关闭每个档案，然后销毁
窗口。

## 连接

```
SshTab.connectTab(tabId)
  → server_connect { profileId, cols, rows, trustHostKey }
       ConnectionManager::connect_shell
         per-profile connect lock
         ensure_connection: reuse a live handle, else
            host key lookup → russh connect (15 s)
            authenticate (password | private key)
            record the key if trustHostKey and it was unknown
            insert into the pool, start the metrics sampler
         open_shell: session channel → request_pty → request_shell
       → { sessionId, connectionId, reused }

reader task → emit "server:output" { sessionId, data: base64 }
xterm onData → server_write { sessionId, data: base64 }
```

**一个档案一条连接，多个通道。** 每个 shell 标签和 SFTP 子系统共用该档案唯一的
SSH 连接；`reused` 报告这次连接是否挂到了已有连接上。每个档案的异步锁防止两个
标签争相发起两次握手。

| 调优项 | 取值 |
| --- | --- |
| 连接超时 | 15 s |
| 写入超时 | 30 s |
| 断开超时 | 5 s |
| Keepalive | 30 s 间隔，三次未收到回应 |
| PTY 类型 | 档案设置，默认 `xterm-256color` |
| 初始尺寸 | xterm 网格；未知时为 80 × 24 |

认证方式是密码或私钥（可选口令）——**不支持 SSH agent、不支持
keyboard-interactive、不支持证书**。主机密钥采用首次使用即信任，按**档案 id**
记录——因此修改档案的主机会保留旧指纹，产生永久性的不匹配，直到忘记该密钥。

## 文件

SFTP 面板是双向的：本地一半由 `server_local_*` 命令提供，远端一半由
`server_sftp_*` 提供。传输任务排队执行：

```
server_transfer_start { profileId, direction, sources, targetDir, conflictPolicy }
  → prepare: stat, resolve conflicts, scan both sides
  → register + spawn worker (semaphore slot from prefs)
       create remote directories
       per file: open "<target>.part", read 32 KiB, write, checkpoint
       finalize: rename ".part" over the target
  → "server:transfer-progress" (≤10/s) … "server:transfer-done"
```

| 属性 | 取值 |
| --- | --- |
| 分块 | 32 KiB |
| 并发 | `prefs.maxConcurrentTransfers`，1–10，默认 3——只读一次，因此修改后需要重启 |
| 暂停 / 取消 | 每个分块检查的原子标志 |
| 续传 | 从 `.part` 文件的大小继续 |
| 进度节流 | 100 ms |
| 保留的已完成行 | 200 |
| 远端列表上限 | 5 000 条 |
| 文本预览 | 2 MiB |

远端路径按词法规范化（折叠 `//`、`.`、`..`，绝不越过 `/`）；符号链接会被列出但
从不跟随，递归删除会解除其链接。下载得到的名字会为 Windows 做净化。

## 监控

监视器在每秒在同一个连接的新 exec 通道上运行一段固定的 POSIX shell 脚本：
`/proc/stat`、`/proc/meminfo`、`/proc/net/dev`、`/proc/diskstats`、
`/proc/loadavg`、`/proc/uptime`、`df -kP /`、`df -iP /`，以及进程/线程计数。
历史保留 300 个样本；连续三次失败后采样器停止，直到连接重新打开才恢复。它随
连接启动，而不是随标签页打开启动。

## 命令与事件

| 分组 | 命令 |
| --- | --- |
| 档案 | `server_profiles_list`、`server_profile_create`、`server_profile_update`、`server_profile_delete`、`server_profile_reorder` |
| 密钥与主机键 | `server_secret_set`、`server_secret_clear`、`server_host_key_get`、`server_host_key_forget`、`server_host_key_trust_pending` |
| SSH | `server_connect`、`server_write`、`server_resize`、`server_disconnect`、`server_connection_close`、`server_sessions_list`、`server_connection_state` |
| SFTP | `server_sftp_home`、`_list`、`_stat`、`_mkdir`、`_rename`、`_delete`、`_read_text`、`_write_text` |
| 本地 | `server_local_home`、`_list`、`_mkdir`、`_rename`、`_delete` |
| 传输 | `server_transfer_start`、`_pause`、`_resume`、`_cancel`、`_list` |
| 监控与偏好 | `server_metrics_history`、`server_prefs_get`、`server_prefs_set` |

| 事件 | 载荷 |
| --- | --- |
| `server:output` | `{ sessionId, data }`，base64 |
| `server:exit` | `{ sessionId, reason }` |
| `server:transfer-progress` | `{ transferId, profileId, transferred, total, bytesPerSec, state }` |
| `server:transfer-done` | `{ transferId, state, error }` |
| `server:metrics` | `{ profileId, sample }` |

连接状态靠轮询而非事件（选择器每 5 s，监控标签每 2 s）。shell 输出是每帧数据
一个事件——大量输出时事件很密，因为没有做批处理。

## 数据布局

```
<data dir>/server/
├── servers.json       # { version: 2, profiles: [...], prefs: {...} }
└── known_hosts.json   # { version: 1, records: { <profileId>: HostKeyRecord } }
```

> ⚠ **密码、口令与私钥以明文存放在 `servers.json` 中。** 文件采用原子写入
> （`servers.json.tmp`、`sync_all`、在进程级锁下 rename），无法解析的文件会被
> 移到 `servers.json.bak-<unix>` 并替换为默认值，但内容并未加密，且界面可以显示
> 它们。OS 钥匙串**仅**用于在向 v2 格式的一次性迁移中读取 v1 密钥。

当前代码中仍有若干字符串声称相反——`lib.rs` 里的 setup 注释、路由描述与
`servers.subtitle` 翻译都说凭据进入系统钥匙串。移植时修正或删除它们；不要把这一
说法带进新应用。

主机密钥是按档案的首次使用即信任记录：`SHA256:<base64>` 加上算法、主机、端口与
信任时间。

## 限制

- **不支持 SSH agent、不支持 keyboard-interactive、不支持证书。**
- SFTP 面板中**不支持 chmod、chown、创建符号链接与服务端复制**。
- **仅支持 Linux 指标**——采样器读取 `/proc`。
- **传输队列在进程内存中。** 重启后行会消失；同一传输再次启动时，`.part` 文件
  仍可支持按偏移续传。
- **主机被修改的档案会保留旧主机密钥**，直到被忘记。
- `server_write` 每次调用接受 1 MiB；文本预览为 2 MiB。

## 把本模块接入其他应用

1. 把 `server-core` 加入 `src-tauri/Cargo.toml`，并通过 `invoke.rs`、`build.rs` 与
   `capabilities/default.json` 暴露 `server_*` 命令。
2. 把 `server-manager` 加入能力窗口列表。
3. 在 setup 中设置 `server_core::paths::CONFIG_DIR` 并注册 `ServerState`。
4. 复制 `src/pages/servers`、`src/pages/server-window` 与 `src/lib/servers`。
5. 添加侧边栏条目——在本应用中 `servers` 组故意不在 `GROUP_ORDER` 里，因此条目
   落入「其他」。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 首次连接报 `host-key-unknown` | 尚无记录——确认指纹并信任 |
| 即使请求了信任仍报 `host-key-mismatch` | 服务器换了密钥，或档案的主机被编辑过；先忘记该密钥 |
| `auth-failed` 附带 `missing-credential` | 档案的密码或密钥为空 |
| `auth-failed` 附带 `remainingMethods` | 服务器禁用了密码认证——改用密钥 |
| 会话中途 `not-connected` | 连接断开或写入超时；重新连接 |
| 编辑后档案消失 | `servers.json` 解析失败并被移到 `.bak` |
| 监控一直停在「等待数据…」 | 不是 Linux 主机、`/proc` 不可读，或采样器在三次失败后停止 |
| "The directory has too many entries to list." | 条目超过 5 000——按路径导航 |
| "The remote file is not valid UTF-8." | 在文本编辑器中打开了二进制文件 |
| 传输停留在 `pending` | 所有并发槽位都被其他传输占用 |
| `conflict-requires-choice` | `ask` 策略直接到达了后端 |
| "not allowed by ACL" | 未在 `build.rs` 或 `capabilities/default.json` 中注册 |
