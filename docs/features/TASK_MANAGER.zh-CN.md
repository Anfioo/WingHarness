# 任务管理器

**任务管理器**页面展示本机正在发生什么：六份标签共享同一份快照——三视图进程表、详情面板与进程操作；带 CPU、内存、磁盘、网络、GPU 与电池详情的性能标签；Windows 服务控制管理器；开机启动项；全部 TCP 与 UDP 端点；以及系统图表的历史回看。可选安装一个 Windows 服务，用来操作系统受保护的进程、控制服务、断开连接，并采集每进程的网络与磁盘流量；不安装时，页面照样监控所有只需要当前账户权限的数据。

它位于侧栏的**其他**分组，只有一个页面，不单独开窗口。设置移到全局设置窗口，后台持续监听开关在托盘弹窗里也有一行。页面挂载期间采样；开启后台监听后，页面关闭仍会采样并把历史写入磁盘。

有两个页面与本页功能刻意重叠：`systools` 有自己的启动项管理，`ports` 有自己的监听端口表。本页不替换它们，见 [SYSTOOLS.md](./SYSTOOLS.zh-CN.md) 与 [PORTS.md](./PORTS.zh-CN.md)。

引擎是 [`src-tauri/argus-core`](../../src-tauri/argus-core)（crate 名 `argus-core`，库名 `argus_core`）与 [`src-tauri/argus-service`](../../src-tauri/argus-service)（crate 名 `argus-service`，库名 `argus_service`）。两者移植自 [Argus](https://github.com/Ray-lea/Argus) 0.3.4（AGPL-3.0-or-later）；移植了哪些、去掉了哪些，见 [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) 与 [argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md)。

## 入口与路由

| 路由 / 窗口 | 渲染内容 |
| --- | --- |
| `/task-manager` | 页面：带服务徽标、刷新与设置操作的标签栏，以及进程、性能、服务、启动项、连接、历史六个标签 |
| 设置窗口的 `taskManager` 分区 | 采样间隔、后台持续监听、历史占用与清理、服务安装 / 更新 / 卸载 |

| 路径 | 职责 |
| --- | --- |
| `src/pages/task-manager/index.tsx` | `AppShell` 内的页面外壳 |
| `src/pages/task-manager/task-manager-app.tsx` | 标签栏（含服务徽标、刷新、设置）、六个标签面板 |
| `src/pages/task-manager/tabs/processes.tsx` | 进程标签：Vitals 带、工具条、表格、内联详情面板、确认对话框 |
| `src/pages/task-manager/tabs/performance.tsx` | 性能标签：设备列表、按设备切换的详情、60 个样本的窗口 |
| `src/pages/task-manager/tabs/services.tsx` | 服务标签：轮询生命周期、搜索 / 筛选 / 排序状态、工具条操作与提示 |
| `src/pages/task-manager/tabs/startup.tsx` | 启动项标签：10 秒轮询、搜索、排序、启停 |
| `src/pages/task-manager/tabs/connections.tsx` | 连接标签：仅在激活且可见时 2 秒轮询、过滤、搜索、右键操作 |
| `src/pages/task-manager/tabs/history.tsx` | 历史标签：范围切换、图表游标、所选时刻的繁忙进程表 |
| `src/components/task-manager/` | 表格、工具条、行、详情内容与操作、右侧详情面板、Vitals 带、硬件概览、分隔条、右键菜单、服务表格与右键菜单、性能设备列表与各设备视图、服务徽标、启动项与连接标签的表格 / 工具条 / 菜单、历史图表与进程表、设置分区的控件、`format.ts` |
| `src/hooks/use-task-manager.ts` | 一份共享 store：通道、设置、服务状态与操作 |
| `src/hooks/use-task-manager-{startup,connections,history,settings}.ts` | 各标签的轮询与状态；`settings` 属于设置窗口 |
| `src/commands/services/task-manager/` | 二十八条 `argus_*` 命令的类型化封装与 DTO |
| `src/lib/task-manager/` | 纯逻辑：`process-search`、`process-sections`、`process-identity`、`process-history`、`performance-target`、`service-rows`、`startup-rows`、`connection-rows`、`history-range`、`history-format`、`history-metrics`、`chart-history`、`chart-scale`、`chart-metrics`、`chart-memory`、`chart-colors`、`engine-grid`、`settings-event` |
| `src/windows/settings/task-manager-section.tsx` | 设置窗口的任务管理器分区 |
| `src/windows/tray-menu/task-manager-row.tsx` | 托盘弹窗的后台持续监听行 |
| `src-tauri/src/commands/argus.rs` | 薄命令层 |
| `src-tauri/src/argus/` | `sampler.rs`（采样线程）、`service.rs`（状态、安装与断开路由）、`store.rs`（设置）、`mod.rs`（`ArgusState`） |

页面本身没有 `standalonePaths` 条目，也没有窗口记录：全部内容都在主窗口的一个路由里。侧栏分组 `taskManager` 故意不在 `src/lib/sidebar-config.ts` 的 `GROUP_ORDER` 中，因此条目落在**其他**。

## 采样生命周期

```
页面挂载
  → useTaskManager() 的 store 启动（仅首个订阅者）
  → argus_settings_get
  → argus_snapshot_start { channel, intervalMs }
      → 采样线程：Collector + ETW 会话 + 服务客户端
      → 每个周期经 ipc::Channel<Snapshot> 送出一帧
      → 后台监听开启时，同一帧同时写入历史记录器
页面卸载（最后一个订阅者）
  → argus_snapshot_stop
      后台关闭 → 线程停止，释放 ETW 会话
      后台开启 → 只退订本页；线程按后台频率继续采样并记录历史
应用退出 → 线程停止
```

- **每页一个订阅。** 页面壳与六个标签都会调用 `useTaskManager()`，但唯一的 `Channel<Snapshot>` 属于模块级 store：第一个调用者启动采样，最后一个卸载者停止它——除非后台监听已开启，此时 `argus_snapshot_stop` 只退订。暂停只丢弃收到的帧，后端继续采样，因此恢复时立刻有数据。
- **后台持续监听**用一个开关（`backgroundMonitoring`）同时控制采样与历史，默认关闭。后台频率为 1–60 秒，默认 5 秒，读取与写入都会夹取。开启后即使没有页面也启动线程；关闭时若无人订阅则停止线程。每次变更都会持久化并广播 `argus-settings-changed`。
- **帧不新增全局事件。** 帧只经 Tauri Channel 送给本页；唯一的全局事件是 `argus-settings-changed`，把设置文档送给页面、设置窗口与托盘行。
- **每次重新建基线。** 每次启动都会新建 collector，所以最初一两个周期没有 CPU 与速率数字（没有上一帧可差分）。离开页面时性能标签的 60 样本窗口随组件卸载清空；已记录的历史不受影响。
- **间隔**为 250–5000 毫秒，默认 1000 毫秒。读取与写入都会夹取，在设置窗口修改后立即重启计时。
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

## 启动项标签

标签列出所有开机启动的程序，来源为五个注册表 / 文件夹位置加上打包应用任务：

| 来源 | 位置 id | 范围 |
| --- | --- | --- |
| `HKCU\…\CurrentVersion\Run` | `hkcuRun` | 当前用户 |
| `HKLM\…\CurrentVersion\Run` | `hklmRun` | 所有用户 |
| `HKLM\Software\WOW6432Node\…\Run` | `hklmRun32` | 所有用户（32 位视图） |
| `%APPDATA%` 下的启动文件夹 | `userFolder` | 当前用户 |
| `%ProgramData%` 下的启动文件夹 | `commonFolder` | 所有用户 |
| AppModel 启动任务 | `package` | 当前用户 |

每行显示名称（程序元数据或快捷方式名）、发布者、状态开关、位置与命令；目标可执行文件不存在时在名称旁标记。搜索匹配名称、条目、发布者、命令与描述；列可按名称、发布者、状态、位置或命令排序。列表每 10 秒轮询一次，且仅在标签激活、文档可见时进行。

- **身份。** `id` 为 `<位置>|<条目>`，也是 `argus_startup_set_enabled` 收到的参数。格式错误或位置未知的 id 在接触注册表之前就被拒绝。
- **启停**写入 12 字节的 `StartupApproved` 值，而不是改条目本身：首字节为偶数表示启用，首字节为奇数并带时间戳表示禁用，与 Windows 自带任务管理器一致。开关先乐观更新，写入失败时回滚并提示。
- **权限。** 当前用户条目立即生效；所有用户条目需要管理员权限，失败按 `access-denied` 提示。被策略管理或当前不可更改的打包任务带 `blocked`，开关禁用。
- **打包任务**从应用清单读取；单个任务读失败会跳过并记日志，不影响整张表。
- **并存。** `systools` 页面有自己的启动项管理，模型不同（扫描、计划、应用）。两者读取同一份 Windows 状态；本标签是任务管理器式的逐项开关，谁也不替换谁。

## 连接标签

标签列出每个 TCP 与 UDP 端点及其进程，数据来自 IPv4 / IPv6 的 `GetExtendedTcpTable` / `GetExtendedUdpTable`。行显示进程、协议、本地端点、远端端点、TCP 状态与 PID；IPv6 端点带方括号。列表每 2 秒轮询一次，且仅在标签激活、文档可见时进行；切回时立即刷新。

- **过滤** — 全部 / 监听 / 已建立 / UDP，均为精确匹配：各种 pending 的 TCP 状态只出现在「全部」下。
- **搜索** — 纯数字查询精确匹配本地端口、远端端口或 PID；其余按本地 / 远端地址、进程名或描述做子串匹配。
- **排序** — 点击列头按进程、协议、本地端点、远端端点、状态或 PID 排序；默认按本地端口升序。
- **转到进程**通过共享的 `revealPid` 把 PID 交给进程标签，并在那边选中该行。结束进程先确认；进程已退出时给出提示，而不是静默失败。
- **断开连接**仅在「已建立 + IPv4 TCP」行、且特权服务运行并已授权时可用。宿主先本地调用 `SetTcpEntry`；遇到 `access-denied` 且自身未提权时，把同一请求交给服务，服务回复为权威结果，绝不在本地重试。UDP、IPv6 与非 established 行不提供断开。
- **复制**可复制本地或远端端点。
- **并存。** `ports` 页面负责 TCP 监听、固定端口与结束端口背后的进程；本标签是任务管理器式的完整端点表，两页都读实时状态，彼此独立。

## 历史标签

后台监听开启时，采样器每 5 秒写一帧到 `<数据目录>/argus/history/<YYYY-MM-DD>.hist`（沿用源实现的 `ARGH` 版本 2 格式），保留 7 天，启动时清理过期文件，打开文件时截断损坏的尾部记录。只有采样器运行时才有历史，因此默认配置（后台关闭）不产生任何文件。

- **范围** — 1 小时、6 小时、24 小时、7 天。每次只向后端请求几百个桶；后端把帧平均进桶，请求最多夹到 4096 桶，并跳过空桶。
- **缺口** — 记录器未运行时图表断线。两点的间距符合周边节奏时连线，最长到 65 秒（最慢的后台间隔加上迟到余量）；更长的停顿会留下可见缺口。
- **游标** — 悬停读取最近时刻；点击或方向键固定，Shift 加大步长，Page Up/Down 跳转，Home/End 到两端，Escape 回到最新点。除非指针正在读取别的时刻，读数跟随固定时刻。
- **进程** — 图表下方的表格显示所选帧里最繁忙的进程。右键或激活一行，在进程仍在运行时转到进程标签；已退出的进程给出提示。
- **空态**区分「记录未开启」（附设置分区入口）、「尚无历史记录」与「查询失败」（可重试）。
- **清理**在设置分区进行。先关闭记录器的文件，只删除 `.hist` 日文件，之后历史标签回到空态。

## 设置分区

任务管理器的设置已从页面移到全局设置窗口的 `taskManager` 分区。页头的齿轮按钮与服务徽标都调用 `openSettingsSection("taskManager")`；设置窗口已打开时收到 `settings-section` 事件并聚焦该分区，而不是再开一个窗口。页面内不再有设置对话框或服务面板。

分区包含：

| 控件 | 行为 |
| --- | --- |
| 采样间隔 | 250 / 500 / 1000 / 2000 / 5000 毫秒，立即保存 |
| 后台持续监听 | 一个开关同时控制采样与历史；频率预设 5 / 10 / 15 / 30 秒（或已保存值） |
| 历史存储 | 当前占用与最早记录、重试，以及确认后清空 |
| 特权服务 | 状态、重新检查、安装、更新与卸载 |

- 所有设置立即保存；保存失败会提示并保留原值。后端夹取两个间隔并广播 `argus-settings-changed`，因此页面、托盘行与本窗口无需轮询即可一致。
- 打开或读取分区绝不会启动页面的采样线程。
- 只有安装、更新与卸载会弹 UAC；取消提示不改变任何状态。

## 托盘行

托盘弹窗（`tray-menu`）在 FRP 之后、退出的分隔线之前有一行：**后台持续监听**。它显示当前值，并通过 `argus_set_background_monitoring` 切换；切换失败会恢复开关并提示。弹窗高度由常量算出，新增该行后 `MENU_ITEM_COUNT` 与高度改为 9 行 / 305 px——见 [TRAY_MENU.md](./TRAY_MENU.zh-CN.md)。

## 特权服务

服务是可选组件。它是名为 `WingHarnessPrivileged` 的 LocalSystem Windows 服务（开发版为 `WingHarnessPrivilegedDev`），监听 `\\.\pipe\WingHarness.Privileged.v1`（开发版 `.Dev.v1`）。宿主与服务使用带版本号的 JSON 协议，操作集由枚举固定：`Ping`、`NetworkSnapshot`、`DiskSnapshot`、`Terminate`、`Priority`、`Efficiency`、`ControlService`、`ServiceStartType` 与 `CloseConnection`。未知操作或字段一律拒绝，`Terminate` 必须带正 PID 与创建时间，服务操作必须给出非空且不超过 256 字节的服务名，`CloseConnection` 必须给出两个非零端口与两个 IPv4 地址——System 进程、Idle 与服务自身永远不是合法目标。操作集为协议版本 4；Ping 始终以版本 1 的信封发送，让旧服务能报告自己的版本，版本 3 及更旧的服务会被识别为过期，而不是把新操作误报为拒绝。

服务提供：

- 对当前账户打不开的进程执行结束、调整优先级与效率模式。
- 对当前账户改不动的服务执行启动、停止、重启与启动类型修改。
- 来自 ETW 会话的每进程网络流量。
- 每进程磁盘计数器（每秒读写字节数）。
- 代表未提权的调用者断开已建立的 IPv4 TCP 连接。连接枚举本身仍在本地完成；只有本地 `SetTcpEntry` 被拒绝时，服务才执行断开。

它刻意**不**提供：内核驱动（PawnIO）、传感器与风扇控制、任务管理器替换、给其他程序提权的助手、句柄或文件占用查询，以及 UDP / IPv6 连接的断开。它不建窗口，也不启动 webview。

### 安装、更新与卸载

| 操作 | 发生什么 |
| --- | --- |
| **安装** | 确认后弹一次 UAC（`ShellExecuteExW` 加 `runas`）。助手把载荷复制到 `%ProgramFiles%\WingHarness Privileged[ Dev]`，把安装账户的 SID 写入 `owner.sid`，创建并启动服务，并把目录限制为 Administrators/SYSTEM 可写 |
| **更新** | 走同一条 UAC 路径替换二进制并重启服务；应用升级后，若已装服务协议不兼容就会提示更新 |
| **卸载** | 弹一次 UAC，然后停止并删除服务，移除其二进制、`owner.sid` 与锁文件；目录只在为空时才删除 |

- 在 UAC 提示中取消不会改变任何状态。失败按错误码提示；目前取消与真正的拒绝一样表现为 `access-denied`，未能区分。
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
| `argus_startup_list` | — | `StartupItem[]` |
| `argus_startup_set_enabled` | `{ id, enabled }` | — |
| `argus_connections_list` | — | `Connection[]` |
| `argus_connections_close` | `{ localAddress, localPort, remoteAddress, remotePort }` | — |
| `argus_history_range` | — | `[起, 止]` Unix 毫秒，或 `null` |
| `argus_history_series` | `{ from, to, buckets }` | `HistoryPoint[]` |
| `argus_history_moment` | `{ ts }` | `HistoryMoment \| null` |
| `argus_history_usage` | — | `HistoryUsage` |
| `argus_history_clear` | — | — |
| `argus_set_background_monitoring` | `{ enabled }` | `ArgusSettings` |

命令必须在四处名单中登记后才可调用：`src/invoke.rs` 的 `all_commands!`、`build.rs` 的 `COMMANDS`、`capabilities/default.json` 与 `permissions/autogenerated/*.toml`。

所有操作都同时携带进程创建时间与 PID，因此 PID 被复用也不会作用到另一个进程。错误形如 `{ code, message, detail? }`；`message` 是英文，只用于日志，前端通过 `argusErrorKey` 按 `code` 翻译：

| 错误码 | 含义 |
| --- | --- |
| `not-found` | 进程已退出、PID 已被复用、服务已不存在、启动项已消失，或历史时刻没有帧 |
| `invalid-input` | 间隔越界、启动项 id 格式错误、断开目标不是 IPv4 或端口为零、历史范围非法、服务动作未知，或目标就是本应用 |
| `access-denied` | 需要管理员权限或特权服务（包括机器级启动项与断开连接） |
| `service-unavailable` | 服务未安装、未运行，或协议版本不兼容 |
| `internal` | 其他 Windows 错误、注册表 / 文件 / COM 失败或聚合失败；`detail` 给出详情 |

## 数据布局

```
<数据目录>/argus/
├── settings.json
└── history/
    └── <YYYY-MM-DD>.hist
```

```json
{
  "version": 2,
  "intervalMs": 1000,
  "backgroundMonitoring": false,
  "backgroundIntervalMs": 5000
}
```

`version` 为将来的迁移写入，读取时忽略。版本 1 的文件缺少后台字段，取默认值，并在下次保存时写回版本 2。目录是 `argus_core::paths::CONFIG_DIR`，在 `src-tauri/src/lib.rs` 中一次性设为 `config::dir().join("argus")`。

- **文件不存在** — 使用默认值，且不写盘。
- **写入** — 先写成 `settings.json.tmp`，`sync_all` 后在一把进程级 `Mutex` 下改名覆盖目标文件。
- **无法解析** — 改名为 `settings.json.bak-<unix 秒>`，内存中回落到默认值，手改坏的文件不会卡住页面。
- **校验** — `intervalMs` 夹到 250–5000，`backgroundIntervalMs` 夹到 1000–60000，读写时都执行；未知字段与更高的 `version` 一律忽略。
- **历史**是本页唯一的持久化例外：日文件位于同一数据目录（绝不使用 `localStorage`），每 5 秒一帧，保留 7 天。只有后台监听开启时才写入，且只能通过 `argus_history_clear` 清理——它先关闭记录器的文件，再删除。

本移植不包含规则或自动化存储。

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
- **后台监听默认关闭。** 全新配置只在页面打开时采样，不写任何历史。可在设置窗口或托盘行开启。
- **历史刻意做短。** 每 5 秒一帧、保留 7 天，一周历史只有几兆字节。采样器必须运行：后台监听关闭期间会留下缺口。
- **断开连接范围有限。** 只能断开已建立的 IPv4 TCP 连接，且只能本地执行或经由特权服务。UDP 与 IPv6 连接可以查看但不能断开。
- **启动项遵循 Windows 规则。** 所有用户条目需要管理员权限，被策略管理的打包任务不可更改，可执行文件已消失的条目仍会列出并标记。

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
| 图表有空档 | 该帧读不到值（速率需要两次采样），或记录器当时未运行；只有这里才会断开 |
| 历史一直为空 | 后台监听未开启（标签会说明并给出设置分区入口），或还没有记录任何帧 |
| **断开连接**不可用 | 该行不是已建立的 IPv4 TCP 连接，或特权服务未运行 / 未授权 |
| 启动项开关提示权限不足 | 该条目属于所有用户，需要管理员权限 |
| 托盘行与设置窗口不一致 | 设置事件没有送达；两者都监听 `argus-settings-changed`，重载窗口后仍复现请上报 |
| 效率模式看不出效果 | 到 Windows 11 的任务管理器里确认；Windows 10 不显示该标记 |

## 许可证

`src-tauri/argus-core` 与 `src-tauri/argus-service` 移植自 Argus（https://github.com/Ray-lea/Argus），版本 0.3.4，AGPL-3.0-or-later。本项目整体为 AGPL-3.0-only；移植部分保留其 AGPL 声明，每个移植文件都带归属头。移植记录见 [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) 与 [argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md)，声明见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
