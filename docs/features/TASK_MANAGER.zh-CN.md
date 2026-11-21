# 任务管理器

**任务管理器**页面展示本机正在发生什么：三视图进程表、详情面板与进程操作，带 CPU、内存、磁盘、网络、GPU 与电池详情的性能标签，以及面向 Windows 服务控制管理器的服务标签。可选安装一个 Windows 服务，用来操作系统受保护的进程、控制服务，并采集每进程的网络与磁盘流量；不安装时，页面照样监控所有只需要当前账户权限的数据。

它位于侧栏的**其他**分组，只有一个页面，不单独开窗口。只有页面挂载期间才采样。

引擎是 [`src-tauri/argus-core`](../../src-tauri/argus-core)（crate 名 `argus-core`，库名 `argus_core`）与 [`src-tauri/argus-service`](../../src-tauri/argus-service)（crate 名 `argus-service`，库名 `argus_service`）。两者移植自 [Argus](https://github.com/Ray-lea/Argus) 0.3.4（AGPL-3.0-or-later）；移植了哪些、去掉了哪些，见 [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) 与 [argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md)。

## 入口与路由

| 路由 | 渲染内容 |
| --- | --- |
| `/task-manager` | 页面：服务摘要、带服务徽标与页面操作的标签栏、进程 / 性能 / 服务三个标签、设置对话框 |

| 路径 | 职责 |
| --- | --- |
| `src/pages/task-manager/index.tsx` | `AppShell` 内的页面外壳 |
| `src/pages/task-manager/task-manager-app.tsx` | 标签栏（含服务徽标、刷新、设置）、三个标签面板 |
| `src/pages/task-manager/tabs/processes.tsx` | 进程标签：Vitals 带、工具条、表格、内联详情面板、确认对话框 |
| `src/pages/task-manager/tabs/performance.tsx` | 性能标签：设备列表、按设备切换的详情、60 个样本的窗口 |
| `src/pages/task-manager/tabs/services.tsx` | 服务标签：轮询生命周期、搜索 / 筛选 / 排序状态、工具条操作与提示 |
| `src/components/task-manager/` | 表格、工具条、行、详情内容与操作、右侧详情面板、Vitals 带、硬件概览、分隔条、右键菜单、服务表格与右键菜单、性能设备列表与各设备视图、服务面板与徽标、设置对话框、`format.ts` |
| `src/hooks/use-task-manager.ts` | 一份共享 store：通道、设置、服务状态与操作 |
| `src/commands/services/task-manager/` | 十八条 `argus_*` 命令的类型化封装与 DTO |
| `src/lib/task-manager/` | 纯逻辑：`process-search`、`process-sections`、`process-identity`、`process-history`、`performance-target`、`service-rows`、`chart-history`、`chart-scale`、`chart-metrics`、`chart-memory`、`chart-colors`、`engine-grid` |
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

- **每页一个订阅。** 页面壳与三个标签都会调用 `useTaskManager()`，但唯一的 `Channel<Snapshot>` 属于模块级 store：第一个调用者启动采样，最后一个卸载者停止它。暂停只丢弃收到的帧，后端继续采样，因此恢复时立刻有数据。
- **不新增全局事件。** 帧只经 Tauri Channel 送给本页，不广播到其他窗口。
- **每次重新建基线。** 每次启动都会新建 collector，所以最初一两个周期没有 CPU 与速率数字（没有上一帧可差分）。离开页面时性能历史随组件卸载一并清空。
- **间隔**为 250–5000 毫秒，默认 1000 毫秒。读取与写入都会夹取，在设置对话框修改后立即重启计时。
- **线程退出后会被替换。** 若页面未经停止就消失（例如窗口重载），`ArgusState` 里留下的句柄已无法送达；下一次 `argus_snapshot_start` 会发现发送失败并新建线程。

## 进程标签

### Vitals 带

工具条上方是一条 128 px 高的卡片带：CPU、内存、磁盘、网络四张，机器有 GPU 时再加最忙的那块 GPU。每张卡显示标题、右侧副读数、当下数值与单位，以及最近 60 个样本的迷你曲线：

| 卡片 | 主数值 | 副读数 | 曲线 |
| --- | --- | --- | --- |
| CPU | 当前利用率 % | 当前频率 GHz | 整体 CPU 利用率 |
| 内存 | 已用 GB / 已安装 GB | 使用率 % | 已用字节（上限为安装容量） |
| 磁盘 | 所有磁盘读写合计速率 | 最忙磁盘的活动时间 % | 合计读写速率 |
| 网络 | 所有适配器接收 + 发送合计速率 | `↓ 接收 · ↑ 发送` | 合计传输速率 |
| GPU | 最忙 GPU 的利用率 % | 其温度 °C | 该 GPU 的利用率 |

这条带子自己维护一份 60 样本窗口（`chart-history.ts`），每个快照推入一个点，与性能页一致，因此跨度同样是 60 × 采样间隔，暂停时随之冻结。每张卡都是按钮：`performance-target.ts` 把设备交给性能标签并切换过去。设备键为 `cpu`、`memory`、`disk:<index>`、`nic:<id>`、`gpu:<id>`；性能页把后三种写成点号形式（`disk.0`），由交接模块负责转换。磁盘卡打开最忙的磁盘，网络卡打开第一个适配器，GPU 卡打开最忙的 GPU——正是卡片上展示读数的设备。

### 三种视图

| 视图 | 行 |
| --- | --- |
| **应用** | 每个应用（拥有应用窗口的进程及其子进程）一个可折叠分组，默认折叠；其余进程随后逐个列出 |
| **进程树** | 父子树，缩进显示，默认展开；折叠一个节点即折叠整棵子树 |
| **列表** | 所有进程平铺 |

`src/lib/task-manager/process-sections.ts` 的 `buildProcessRows` 从同一份快照生成三种视图。进程树用显式栈沿父链遍历（不递归），缩进到 `MAX_TREE_DEPTH = 32` 层为止；父链成环的节点会兜底显示，而不是被丢掉。

### 搜索、排序与虚拟滚动

搜索匹配进程名、PID 与映像路径，忽略大小写并去掉首尾空白；空查询时 `createProcessMatcher` 返回 `null`，不执行筛选。应用视图中，查询会展开命中的分组并隐藏没有命中的分组。空结果有独立状态，并提供**清除搜索**操作。

点击列头可按名称、PID、CPU、内存、磁盘读取、磁盘写入、I/O、网络、GPU、线程或句柄排序；数字列第一次点击为降序（最忙的在前），默认按 CPU 降序。分组按聚合值排序；磁盘速率仍为 `null` 的进程排在已测量进程之后。

表格用 `@tanstack/react-virtual` 按固定 32 px 行高虚拟化，只有视口附近的行存在 DOM 中，因此本机有 300 个进程时滚动也不会跳。列头固定在顶部。

### 列

名称（带可执行文件图标与缩进）、PID、CPU、内存、磁盘读取、磁盘写入、I/O、GPU、网络、线程与句柄。图标来自采样器的按可执行文件缓存，按需获取；没有图标时退回通用应用图标（无映像路径的进程退回内核图标）。网络列只在服务测量时出现，未安装服务时整列隐藏，工具条会说明原因。已挂起的进程在名称旁显示标签，不再占用状态列。

### 详情面板

选中一行后，表格右侧打开详情面板。表格与面板各自滚动（表格保留自身的横向滚动），页面整体不会横向溢出。面板默认宽 360 px，可拖动左边缘、用方向键或在双击后回到默认值，范围 280–520 px；宽度只是组件状态，不写入偏好，因此重新进入页面总是默认宽度。

面板顶部是可执行文件图标、标签、名称、PID、公司与关闭按钮（清除选中）。其下是 CPU、内存、磁盘迷你图，服务测量网络时再加网络迷你图，机器有 GPU 时再加 GPU；它们画的是该进程实例自己的 60 样本窗口（`process-history.ts`，按 `pid:createTime` 建键，最多保留 500 个进程，且只保留最新快照中仍存在的进程）。再往下是原有分区——进程、资源、路径、命令行与版本——复制与结束操作固定在底部。快字段（路径、资源、线程、句柄）来自快照；慢字段（命令行、用户、完整性级别、架构、优先级、版本资源）来自 `argus_process_details`。面板已切换到另一个进程后才返回的响应会被丢弃；无法打开的进程返回 `accessible: false`，面板说明原因而不是显示空白字段。

未选中任何进程时，面板列出本机的部件——处理器、内存、每块磁盘、适配器、GPU 与电池及其关键读数——配色与性能页一致，每行都可以打开性能标签的对应设备。进程退出后选中自动清除，面板也随之回到这份概览。

### 操作

| 操作 | 行为 |
| --- | --- |
| **结束任务** | 确认对话框后调用 `argus_kill_process` |
| **结束进程树** | 确认对话框写明子进程数量，然后调用 `argus_kill_process_tree` |
| **优先级** | 子菜单（低 … 实时）；实时需要二次确认，然后调用 `argus_set_priority` |
| **效率模式** | 开/关切换，然后调用 `argus_set_efficiency` |

页面从不结束自己的进程：宿主拒绝该 PID，菜单也会在页面所在的可执行文件上禁用操作。结束系统进程需要特权服务——宿主先本地尝试，只在 `access-denied` 时才把操作交给服务。结束进程树的提示以返回的 `TreeKillReport` 为准，未能结束的子进程会被单独指出，而不是一律算作成功。

## 性能标签

左侧是设备列表，右侧是所选设备的详情，与系统任务管理器的性能页一致。列表为 CPU、内存、每块物理磁盘、每个网络适配器、每块 GPU 与每块电池各列一项；每项显示当前读数，以及同一采样窗口的迷你曲线。点击即可切换详情；设备消失时选择自动退回第一项。

- **CPU** — 总利用率与内核时间，或逻辑处理器网格（每个线程一张带曲线的卡片）。混合架构 CPU 可在全部 / P 核 / E 核之间过滤，并可在总体与逐核视图之间切换；下方列出基准速度、插槽、核心数、缓存与虚拟化。
- **内存** — 使用中、可用、已提交、已缓存、分页池与内存组成条；以及已安装模组的速度、插槽、规格与类型。
- **磁盘** — 每块物理磁盘的活动时间与读写速率、响应时间、容量、总线和温度。
- **网络** — 每个适配器的接收/发送速率、链路速度、地址与 MAC。
- **GPU** — 引擎利用率网格与专用、共享显存曲线，两部分之间可拖动分隔条；引擎图可用智能显示或指定数量、每图单独选择引擎，并支持网格 / 焦点 / 列表布局。下方为时钟、温度、风扇与功耗。
- **电池** — 电量与充放电功率、相对设计容量的损耗、循环次数与电池身份信息。没有电池的机器不显示该项。

历史是 60 个样本（`chart-history.ts`），每个快照一个点。每帧推入一个点并丢掉最旧的点，因此相邻读数始终相连，样本之间不再断开；只有读不到的值（例如首帧还没有速率）才记为 `null`。窗口跨度因此是 60 × 采样间隔——1 秒间隔为 60 秒，5 秒间隔为 300 秒——坐标标签随之变化。暂停会冻结窗口：不再推入新点，右端不再移动。离开页面时该标签卸载，历史随之丢弃。

每种资源有独立的色相（`--perf-cpu`、`--perf-mem`、`--perf-io`、`--perf-net`、`--perf-gpu`、`--perf-bat`），深色主题另有一套更亮的取值。混合架构 CPU 的 P 核与 E 核使用不同颜色。

电池数据来自电池类驱动的 IOCTL（`powercfg /batteryreport` 背后的数据源），不经过 WMI；标准用户即可只读打开这些设备。

## 服务标签

标签列出服务控制管理器里的全部 Win32 服务：显示名、服务名、宿主 PID、状态、启动类型与描述。它是普通表格——最多几百行，因此不做虚拟滚动——表头粘性，行高与进程表一致的 32 px。

### 数据与轮询

- **每次读取只遍历一次 SCM。** `argus_services_list` 用一次 `EnumServicesStatusExW` 取回所有服务的状态与 PID。静态配置（显示名、启动类型、二进制路径、账户、描述）每个服务要三次 RPC，因此 `ServiceCatalog` 缓存 60 秒；控制操作或修改启动类型后，`invalidate` 只丢弃对应条目。
- **显示名按调用者语言读取。** 描述先取服务配置，存在注册表 MUI 字符串时再覆盖，所以本地化的 Windows 显示本地化文本。
- **轮询只看标签与可见性。** 标签被选中时立即拉一次，随后每 3 秒一次，但仅限标签处于选中**且** `document.visibilityState` 为 `visible` 时。切到进程 / 性能、隐藏页面或卸载标签都会清掉计时器；重新可见时立即拉取。列表只存在标签自己的组件状态里，不进入 `Snapshot` 或共享的 `useTaskManager` store。
- **普通用户也能读列表。** `EnumServicesStatusExW` 不需要提权；账户读不到的配置项会让 `startType` 为 `null`，表格显示为 `—`。

### 搜索、筛选与排序

搜索匹配显示名、服务名、描述或精确 PID。状态筛选为**全部 / 运行中 / 已停止**：运行中与已停止都是精确匹配，因此各种 pending 状态只会出现在「全部」下。点击列头按服务、服务名、PID、状态、启动类型或描述排序；默认按显示名升序，再点当前列切换升降。启动类型按 Windows 自身的顺序排序（引导、系统、自动、自动延迟、手动、禁用），未知值排最后。排序是稳定的：相同值保持到达时的顺序。这些逻辑集中在 `src/lib/task-manager/service-rows.ts`，由 vitest 覆盖。

空态彼此区分：首次读取时显示骨架；读取失败时显示翻译后的错误与重试按钮；有列表但当前搜索或筛选无结果时提供**清除筛选**。

### 操作

| 操作 | 行为 |
| --- | --- |
| **启动 / 停止 / 重启** | 工具条按钮作用于选中行；右键菜单作用于被右击的行 |
| **启动类型** | 右键子菜单：自动、自动（延迟启动）、手动、禁用；当前项显示选中 |
| **复制服务名** | 复制键名 |
| **打开文件所在位置** | 从服务命令行中解析出可执行文件，用 `systools_reveal_in_file_manager` 定位 |
| **打开服务控制台** | 以独立进程启动 `mmc.exe services.msc` |

- **禁用规则。** pending 状态（或已有操作在执行）的服务不能操作。运行中禁用启动；服务不接受停止请求（`canStop`）时禁用停止与重启，驱动和不带停止控制的服务都属于这种情况。
- **每个操作都以提示结束**，错误按 `code` 经 `argusErrorKey` 翻译，结束后刷新列表。
- **权限路由。** 宿主先用自己的权限调用 SCM；只有 `access-denied` 且宿主未提权时，才把同一操作交给特权服务，服务回复为权威结果，宿主不会在本地重试。停止受保护服务与修改任何启动类型通常都需要管理员权限或特权服务。若已装服务协议较旧，会报告为需要更新，而不是给出误导性的权限不足。
- **有意不做的项。** Argus 的行标记（置顶 / 笔记）、「转到进程」跳转，以及双击行跳到进程标签，都不在本期移植范围内；行上不保留任何需要它们的操作。

## 特权服务

服务是可选组件。它是名为 `WingHarnessPrivileged` 的 LocalSystem Windows 服务（开发版为 `WingHarnessPrivilegedDev`），监听 `\\.\pipe\WingHarness.Privileged.v1`（开发版 `.Dev.v1`）。宿主与服务使用带版本号的 JSON 协议，操作集由枚举固定：`Ping`、`NetworkSnapshot`、`DiskSnapshot`、`Terminate`、`Priority`、`Efficiency`、`ControlService` 与 `ServiceStartType`。未知操作或字段一律拒绝，`Terminate` 必须带正 PID 与创建时间，服务操作必须给出非空且不超过 256 字节的服务名——System 进程、Idle 与服务自身永远不是合法目标。操作集为协议版本 3；Ping 始终以版本 1 的信封发送，让旧服务能报告自己的版本，版本 2 的服务会被识别为过期，而不是把新操作误报为拒绝。

服务提供：

- 对当前账户打不开的进程执行结束、调整优先级与效率模式。
- 对当前账户改不动的服务执行启动、停止、重启与启动类型修改。
- 来自 ETW 会话的每进程网络流量。
- 每进程磁盘计数器（每秒读写字节数）。

它刻意**不**提供：内核驱动（PawnIO）、传感器与风扇控制、任务管理器替换、给其他程序提权的助手、句柄或文件占用查询、连接管理。它不建窗口，也不启动 webview。

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
| `argus_icon` | `{ id }` | PNG data URL；图标尚未解析时为 `null` |
| `argus_kill_process` | `{ pid, createTime, force }` | — |
| `argus_kill_process_tree` | `{ pid, createTime }` | `TreeKillReport` |
| `argus_set_priority` | `{ pid, createTime, priority }` | 进程最终生效的优先级 |
| `argus_set_efficiency` | `{ pid, createTime, on }` | — |
| `argus_service_status` | — | `ServiceStatus` |
| `argus_service_manage` | `{ action }`（`install` / `uninstall` / `update`） | `ServiceStatus` |
| `argus_services_list` | — | `ServiceInfo[]` |
| `argus_service_control` | `{ name, action }`（`start` / `stop` / `restart`） | — |
| `argus_service_start_type` | `{ name, startType }`（`auto` / `autoDelayed` / `manual` / `disabled`） | — |
| `argus_services_console` | — | — |

命令必须在四处名单中登记后才可调用：`src/invoke.rs` 的 `all_commands!`、`build.rs` 的 `COMMANDS`、`capabilities/default.json` 与 `permissions/autogenerated/*.toml`。

所有操作都同时携带进程创建时间与 PID，因此 PID 被复用也不会作用到另一个进程。错误形如 `{ code, message, detail? }`；`message` 是英文，只用于日志，前端通过 `argusErrorKey` 按 `code` 翻译：

| 错误码 | 含义 |
| --- | --- |
| `not-found` | 进程已退出、PID 已被复用，或服务已不存在 |
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
- **磁盘与网络需要预热。** 速率需要两次采样，最初的周期显示 `—`；刚启动的进程还没有磁盘或网络行。
- **每进程网络需要服务。** 未安装时网络列整列隐藏，工具条提示会说明原因。
- **服务控制需要权限。** 读取服务列表不需要任何权限，但启动、停止受保护服务或修改启动类型需要管理员权限或特权服务。账户读不到的配置会把启动类型显示为 `—`。
- **GPU 与磁盘硬件可能缺失。** 没有受支持 GPU 或没有磁盘计数器的机器显示面板的空态，而不是错误。
- **受保护进程。** 详情面板会说明读不到命令行、用户或版本，而不是显示空值。
- **服务可能残留。** 升级或卸载应用不会改动已安装的服务。升级后用**更新服务**，或用**卸载**移除它。

## 故障排查

| 现象 | 可能原因 |
| --- | --- |
| 提示 "not allowed by ACL" | 命令没有登记在 `build.rs` 或 `capabilities/default.json` |
| 表格一直是空的 | `argus_snapshot_start` 失败——在开发者控制台看英文 `message` |
| 返回页面后收不到帧 | 上一个采样线程已退出；下一次启动会替换它，重载页面，若仍复现请上报 |
| 网络列不出现 | 特权服务未安装或未运行 |
| 结束系统进程提示权限不足 | 需要安装服务；提示里会写明 |
| 启停受保护服务提示权限不足 | 安装特权服务，或以管理员身份运行应用；列表下方有说明 |
| 修改启动类型提示权限不足 | 修改启动类型始终需要管理员权限或特权服务 |
| 服务徽标显示不兼容 | 已装服务是另一版协议；使用**更新服务** |
| 设置恢复默认 | `settings.json` 无法解析；在数据目录找 `settings.json.bak-*` |
| 图表有空档 | 该帧读不到值（速率需要两次采样）；只有这里才会断开 |
| 效率模式看不出效果 | 到 Windows 11 的任务管理器里确认；Windows 10 不显示该标记 |

## 许可证

`src-tauri/argus-core` 与 `src-tauri/argus-service` 移植自 Argus（https://github.com/Ray-lea/Argus），版本 0.3.4，AGPL-3.0-or-later。本项目整体为 AGPL-3.0-only；移植部分保留其 AGPL 声明，每个移植文件都带归属头。移植记录见 [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) 与 [argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md)，声明见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
