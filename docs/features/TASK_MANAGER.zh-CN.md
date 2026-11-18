# 任务管理器

**任务管理器**页面展示本机正在发生什么：三视图进程表、详情面板与进程操作，以及带 CPU、内存、磁盘、网络与 GPU 曲线的性能标签。可选安装一个 Windows 服务，用来操作系统受保护的进程，并采集每进程的网络与磁盘流量；不安装时，页面照样监控所有只需要当前账户权限的数据。

它位于侧栏的**其他**分组，只有一个页面，不单独开窗口。只有页面挂载期间才采样。

引擎是 [`src-tauri/argus-core`](../../src-tauri/argus-core)（crate 名 `argus-core`，库名 `argus_core`）与 [`src-tauri/argus-service`](../../src-tauri/argus-service)（crate 名 `argus-service`，库名 `argus_service`）。两者移植自 [Argus](https://github.com/Ray-lea/Argus) 0.3.4（AGPL-3.0-or-later）；移植了哪些、去掉了哪些，见 [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) 与 [argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md)。

## 入口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/task-manager` | 页面：页头、服务摘要、标签栏、进程与性能两个标签、设置对话框 |

| 路径 | 职责 |
| --- | --- |
| `src/pages/task-manager/index.tsx` | `AppShell` 内的页面外壳 |
| `src/pages/task-manager/task-manager-app.tsx` | 页头（标题、服务徽标、刷新、设置）、标签栏、两个标签面板 |
| `src/pages/task-manager/tabs/processes.tsx` | 进程标签：工具条、表格、详情抽屉、确认对话框 |
| `src/pages/task-manager/tabs/performance.tsx` | 性能标签：摘要卡、五个面板、60 秒窗口 |
| `src/components/task-manager/` | 表格、工具条、行、详情、右键菜单、五个性能面板、摘要、服务面板与徽标、设置对话框、`format.ts` |
| `src/hooks/use-task-manager.ts` | 一份共享 store：通道、设置、服务状态与操作 |
| `src/commands/services/task-manager/` | 十三条 `argus_*` 命令的类型化封装与 DTO |
| `src/lib/task-manager/` | 纯逻辑：`process-search`、`process-sections`、`process-identity`、`chart-history`、`chart-scale`、`chart-metrics`、`chart-memory`、`chart-colors` |
| `src-tauri/src/commands/argus.rs` | 薄命令层 |
| `src-tauri/src/argus/` | `sampler.rs`（采样线程）、`service.rs`（状态与安装）、`store.rs`（设置）、`mod.rs`（`ArgusState`） |

这里没有 `standalonePaths` 条目，也没有窗口记录：全部内容都在主窗口的一个路由里。侧栏分组 `taskManager` 故意不在 `src/lib/sidebar-config.ts` 的 `GROUP_ORDER` 中，因此条目落在**其他**。

## 采样生命周期

```
页面挂载
  → useTaskManager() 的 store 启动（仅首个订阅者）
  → argus_settings_get
  → argus_snapshot_start { channel, intervalMs }
      → 采样线程：Collector + ETW 会话 + 服务客户端
      → 每个周期经 ipc::Channel<Snapshot> 送出一帧
页面卸载（最后一个订阅者）或应用退出
  → argus_snapshot_stop
  → 线程停止，释放 ETW 会话
```

- **每页一个订阅。** 页面壳与两个标签都会调用 `useTaskManager()`，但唯一的 `Channel<Snapshot>` 属于模块级 store：第一个调用者启动采样，最后一个卸载者停止它。暂停只丢弃收到的帧，后端继续采样，因此恢复时立刻有数据。
- **不新增全局事件。** 帧只经 Tauri Channel 送给本页，不广播到其他窗口。
- **每次重新建基线。** 每次启动都会新建 collector，所以最初一两个周期没有 CPU 与速率数字（没有上一帧可差分）。离开页面时性能历史随组件卸载一并清空。
- **间隔**为 250–5000 毫秒，默认 1000 毫秒。读取与写入都会夹取，在设置对话框修改后立即重启计时。
- **线程退出后会被替换。** 若页面未经停止就消失（例如窗口重载），`ArgusState` 里留下的句柄已无法送达；下一次 `argus_snapshot_start` 会发现发送失败并新建线程。

## 进程标签

### 三种视图

| 视图 | 行 |
| --- | --- |
| **应用** | 每个应用（拥有应用窗口的进程及其子进程）一个可折叠分组，默认折叠；其余进程随后逐个列出 |
| **进程树** | 父子树，缩进显示，默认展开；折叠一个节点即折叠整棵子树 |
| **列表** | 所有进程平铺 |

`src/lib/task-manager/process-sections.ts` 的 `buildProcessRows` 从同一份快照生成三种视图。进程树用显式栈沿父链遍历（不递归），缩进到 `MAX_TREE_DEPTH = 32` 层为止；父链成环的节点会兜底显示，而不是被丢掉。

### 搜索、排序与虚拟滚动

搜索匹配进程名、PID 与映像路径，忽略大小写并去掉首尾空白；空查询时 `createProcessMatcher` 返回 `null`，不执行筛选。应用视图中，查询会展开命中的分组并隐藏没有命中的分组。空结果有独立状态，并提供**清除搜索**操作。

点击列头可按名称、PID、CPU、内存、磁盘、网络或 GPU 排序；数字列第一次点击为降序（最忙的在前），默认按 CPU 降序。分组按聚合值排序；磁盘速率仍为 `null` 的进程排在已测量进程之后。

表格用 `@tanstack/react-virtual` 按固定 32 px 行高虚拟化，只有视口附近的行存在 DOM 中，因此本机有 300 个进程时滚动也不会跳。列头固定在顶部。

### 列

名称（带应用图标与缩进）、PID、CPU、内存、磁盘、网络、GPU、用户与状态。磁盘列显示读写合计，tooltip 给出两者的速率；网络列在服务未测量时显示 `—`；用户列暂无生产者，显示 `—`；状态显示运行中或已挂起。

### 详情面板

选中一行会打开详情抽屉，并按需调用 `argus_process_details`。快字段（路径、资源、线程、句柄）来自快照；慢字段（命令行、用户、完整性级别、架构、优先级、版本资源）来自该调用。无法打开的进程返回 `accessible: false`，抽屉说明原因而不是显示空白字段。抽屉已切换到另一个进程后才返回的响应会被丢弃。PID 与路径都可以从抽屉复制。

### 操作

| 操作 | 行为 |
| --- | --- |
| **结束任务** | 确认对话框后调用 `argus_kill_process` |
| **结束进程树** | 确认对话框写明子进程数量，然后调用 `argus_kill_process_tree` |
| **优先级** | 子菜单（低 … 实时）；实时需要二次确认，然后调用 `argus_set_priority` |
| **效率模式** | 开/关切换，然后调用 `argus_set_efficiency` |

页面从不结束自己的进程：宿主拒绝该 PID，菜单也会在页面所在的可执行文件上禁用操作。结束系统进程需要特权服务——宿主先本地尝试，只在 `access-denied` 时才把操作交给服务。结束进程树的提示以返回的 `TreeKillReport` 为准，未能结束的子进程会被单独指出，而不是一律算作成功。

## 性能标签

五张摘要卡（CPU、内存、磁盘、网络、GPU）显示当前读数与 60 秒峰值，并带占比条。下方五个 canvas 面板绘制：

- **CPU** — 总利用率、每逻辑处理器利用率与 CPU 标识。
- **内存** — 使用中与已提交总量，以及内存组成（使用中、已修改、备用、可用）。
- **磁盘** — 每个卷的活动时间、读取与写入速率。
- **网络** — 每个适配器的接收与发送速率。
- **GPU** — 利用率、专用与共享显存，以及最忙的引擎。

历史是 60 个 1 秒桶（`chart-history.ts`）。落在已有桶里的快照会覆盖该桶；没有采到样本的桶保持 `null`，折线在此断开而不是拉伸。因此采样间隔大于 1 秒时，图上表现为空档而不是斜坡。暂停会冻结窗口：不再推入新桶，右端不再移动。离开页面时该标签卸载，历史随之丢弃。

## 特权服务

服务是可选组件。它是名为 `WingHarnessPrivileged` 的 LocalSystem Windows 服务（开发版为 `WingHarnessPrivilegedDev`），监听 `\\.\pipe\WingHarness.Privileged.v1`（开发版 `.Dev.v1`）。宿主与服务使用带版本号的 JSON 协议，操作集由枚举固定：`Ping`、`NetworkSnapshot`、`DiskSnapshot`、`Terminate`、`Priority` 与 `Efficiency`。未知操作或字段一律拒绝，`Terminate` 必须带正 PID 与创建时间——System 进程、Idle 与服务自身永远不是合法目标。

服务提供：

- 对当前账户打不开的进程执行结束、调整优先级与效率模式。
- 来自 ETW 会话的每进程网络流量。
- 每进程磁盘计数器（每秒读写字节数）。

它刻意**不**提供：内核驱动（PawnIO）、传感器与风扇控制、任务管理器替换、给其他程序提权的助手、句柄或文件占用查询、连接管理、服务控制。它不建窗口，也不启动 webview。

### 安装、更新与卸载

| 操作 | 发生什么 |
| --- | --- |
| **安装** | 确认后弹一次 UAC（`ShellExecuteExW` 加 `runas`）。助手把载荷复制到 `%ProgramFiles%\WingHarness Privileged[ Dev]`，把安装账户的 SID 写入 `owner.sid`，创建并启动服务，并把目录限制为 Administrators/SYSTEM 可写 |
| **更新** | 走同一条 UAC 路径替换二进制并重启服务；应用升级后，若已装服务协议不兼容就会提示更新 |
| **卸载** | 弹一次 UAC，然后停止并删除服务，移除其二进制、`owner.sid` 与锁文件；目录只在为空时才删除 |

- 在 UAC 提示中取消不会改变任何状态；页面会重新读取状态并给出中性提示，而不是报错。
- 服务随 Windows 启动并常驻，应用关闭后仍然运行。卸载应用不会移除它——请在本页卸载。
- 只有 `owner.sid` 中记录的账户获授权。其他账户会看到服务「未授权」，无法使用。
- 宿主总是先本地执行。只有 `access-denied` 且宿主自身未提权时，才把同一操作交给服务。服务的回复是权威结果，宿主不会在本地重试，因此回复丢失也不会把同一个进程结束两次。
- 启动时绝不隐式安装或提权。

## 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `argus_snapshot_start` | `{ channel, intervalMs }` | — |
| `argus_snapshot_stop` | — | — |
| `argus_set_interval` | `{ intervalMs }` | `ArgusSettings` |
| `argus_refresh` | — | — |
| `argus_settings_get` | — | `ArgusSettings` |
| `argus_settings_set` | `{ settings }` | 实际写入的规范化设置 |
| `argus_process_details` | `{ pid }` | `ProcessDetails` |
| `argus_kill_process` | `{ pid, createTime, force }` | — |
| `argus_kill_process_tree` | `{ pid, createTime }` | `TreeKillReport` |
| `argus_set_priority` | `{ pid, createTime, priority }` | 进程最终生效的优先级 |
| `argus_set_efficiency` | `{ pid, createTime, on }` | — |
| `argus_service_status` | — | `ServiceStatus` |
| `argus_service_manage` | `{ action }`（`install` / `uninstall` / `update`） | `ServiceStatus` |

命令必须在四处名单中登记后才可调用：`src/invoke.rs` 的 `all_commands!`、`build.rs` 的 `COMMANDS`、`capabilities/default.json` 与 `permissions/autogenerated/*.toml`。

所有操作都同时携带进程创建时间与 PID，因此 PID 被复用也不会作用到另一个进程。错误形如 `{ code, message, detail? }`；`message` 是英文，只用于日志，前端通过 `argusErrorKey` 按 `code` 翻译：

| 错误码 | 含义 |
| --- | --- |
| `not-found` | 进程已退出，或 PID 已被复用 |
| `invalid-input` | 间隔越界、服务动作未知，或目标就是本应用 |
| `access-denied` | 需要管理员权限或特权服务 |
| `service-unavailable` | 服务未安装、未运行，或协议版本不兼容 |
| `internal` | 其他 Windows 错误；`detail` 给出详情 |

## 数据布局

```
<数据目录>/argus/
└── settings.json
```

```json
{
  "version": 1,
  "intervalMs": 1000
}
```

`version` 为将来的迁移写入，读取时忽略。目录是 `argus_core::paths::CONFIG_DIR`，在 `src-tauri/src/lib.rs` 中一次性设为 `config::dir().join("argus")`。

- **文件不存在** — 使用默认值，且不写盘。
- **写入** — 先写成 `settings.json.tmp`，`sync_all` 后在一把进程级 `Mutex` 下改名覆盖目标文件。
- **无法解析** — 改名为 `settings.json.bak-<unix 秒>`，内存中回落到默认值，手改坏的文件不会卡住页面。
- **校验** — `intervalMs` 在读与写时都夹到 250–5000；未知字段与更高的 `version` 一律忽略。

除此之外不持久化任何东西：本次移植没有历史库，也没有规则库。

## 限制与平台说明

- **仅 Windows。** 两个 crate 都是 `cfg(windows)`，没有 macOS 或 Linux 路径。
- **Windows 10 与 Windows 11。** 效率模式通过 EcoQoS 的 `SetProcessInformation` 设置，Windows 10 22H2 接受该调用；但 Windows 10 的任务管理器不显示它，因此无法按验收清单要求在那里确认效果，请在 Windows 11 上验证。
- **拿不到 CPU 频率。** `cpuMhz` 恒为 `null`，`coreMhz` 为空，因为唯一来源是未移植的传感器模块。速度行与逐核频率行因此隐藏。
- **用户列为空。** `ProcessRow` 没有 `user` 字段；为了每个进程每个周期都读一次令牌所有者并不划算，所以该列在有生产者之前显示 `—`。
- **磁盘与网络需要预热。** 速率需要两次采样，最初的周期显示 `—`；刚启动的进程还没有磁盘或网络行。
- **每进程网络需要服务。** 未安装时该列显示 `—`，工具条提示会说明原因。
- **GPU 与磁盘硬件可能缺失。** 没有受支持 GPU 或没有磁盘计数器的机器显示面板的空态，而不是错误。
- **受保护进程。** 详情抽屉会说明读不到命令行、用户或版本，而不是显示空值。
- **服务可能残留。** 升级或卸载应用不会改动已安装的服务。升级后用**更新服务**，或用**卸载**移除它。

## 故障排查

| 现象 | 可能原因 |
| --- | --- |
| 提示 "not allowed by ACL" | 命令没有登记在 `build.rs` 或 `capabilities/default.json` |
| 表格一直是空的 | `argus_snapshot_start` 失败——在开发者控制台看英文 `message` |
| 返回页面后收不到帧 | 上一个采样线程已退出；下一次启动会替换它，重载页面，若仍复现请上报 |
| 网络列显示 `—` | 特权服务未安装或未运行 |
| 结束系统进程提示权限不足 | 需要安装服务；提示里会写明 |
| 服务徽标显示不兼容 | 已装服务是另一版协议；使用**更新服务** |
| 设置恢复默认 | `settings.json` 无法解析；在数据目录找 `settings.json.bak-*` |
| 图表有空档 | 采样间隔大于 1 秒，并非每个桶都有样本 |
| 效率模式看不出效果 | 到 Windows 11 的任务管理器里确认；Windows 10 不显示该标记 |

## 许可证

`src-tauri/argus-core` 与 `src-tauri/argus-service` 移植自 Argus（https://github.com/Ray-lea/Argus），版本 0.3.4，AGPL-3.0-or-later。本项目整体为 AGPL-3.0-only；移植部分保留其 AGPL 声明，每个移植文件都带归属头。移植记录见 [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) 与 [argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md)，声明见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
