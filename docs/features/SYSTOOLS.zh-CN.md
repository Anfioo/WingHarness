# 系统工具

**系统工具**页面是一个 Windows 维护控制台：启动项、应用卸载与残留、可回滚的系统
设置、磁盘分析、重复文件与大文件。它位于侧边栏「工作台」分组，并且可以分离为
独立窗口 `/systools-window?tab=…`。

本模块改编自 [MangoDisk](https://github.com/harry0703/MangoDisk)（GPL-3.0-only），
这也是本项目采用 GPL-3.0 而非 MIT 的原因。引擎为
[`src-tauri/systools-core`](../../src-tauri/systools-core)。

## 六个标签页

| 键 | 英文 | 中文 |
| --- | --- | --- |
| `startup` | Startup | 启动项 |
| `uninstall` | Uninstall | 卸载与残留 |
| `optimize` | Optimize | 系统优化 |
| `analysis` | Analysis | 磁盘分析 |
| `duplicates` | Duplicates | 重复文件 |
| `largeFiles` | Large files | 大文件 |

六个面板在隐藏时都保持挂载，因此扫描结果能跨标签切换保留。窗口永远只有一个：
再次打开页面会聚焦已有窗口，并向它发送 `systools-select-tab`。

## 架构

```
page tabs (src/pages/systools/tabs/*)
  └─ src/lib/systools/* + src/commands/services/systools (DTOs, path helpers, errors)
       └─ invoke("systools_*")
            └─ systools-core/src/commands.rs      thin façade
                 ├─ storage/analysis, duplicates, large_files, index
                 ├─ applications/uninstall, leftovers
                 ├─ startup, system_settings
                 ├─ filesystem (permanent delete, exclusions)
                 └─ platform/  ── trait Platform ── WindowsPlatform (only impl)
```

`platform/contracts` 定义了一个约三十个方法的 `Platform` trait，每个方法都有安全
的默认实现：未实现的快路径返回 `None`，遍历随即回退到可移植的有界遍历。因此
移植到其他操作系统只需要写一个适配器；目前只存在 `WindowsPlatform`，仅限
Windows 的快路径有基于 MFT 的分析记录、大文件候选查询与目录项标识。

扫描一个目录：

```
systools_analysis_scan { path, refresh, excludedPaths, excludedNames, scanMode }
  → resolve_exclusion_paths   (≤50, absolute, no links)
  → traversal (parallel walk, or the Windows fast path)
       Platform::should_skip / is_link_like / file_space_usage
       storage::index cache (in memory, 2 roots)
  → events "systools:analysis-progress"
  → AnalysisResult { root, totalBytes, entries[≤500], directoryHierarchy, coverage }
```

## 命令

| 分组 | 命令 |
| --- | --- |
| 磁盘分析 | `systools_analysis_scan`、`_cancel`、`_remainder_list`、`_remainder_release`、`_export`、`_delete_entries` |
| 重复文件 | `systools_duplicates_scan`、`_cancel`、`_page`、`_delete` |
| 大文件 | `systools_large_files_scan`、`_filter`、`_cancel`、`_delete` |
| 系统优化 | `systools_system_settings_scan`、`_cancel_scan`、`_prepare_change`、`_execute_change` |
| 启动项 | `systools_startup_scan`、`_cancel_scan`、`_prepare_change`、`_execute_change`、`_cancel_change` |
| 卸载与残留 | `systools_uninstall_scan`、`_cancel_scan`、`_describe_identity`、`_close_applications`、`_prepare_batch`、`_execute_batch`、`_cancel_execution`、`_remove_record`、`_open_windows_apps`、`systools_leftovers_scan`、`_execute`、`_cancel` |
| 共用 | `systools_volumes_list`、`_system_disk`、`_filter_directory_paths`、`_reveal_in_file_manager`、`_open_*_entry`、`_file_icons`、`_application_icons` |
| 偏好 | `systools_prefs_get`、`systools_prefs_set` |

**每一次变更都是一个计划。** `scan` 负责观察，`prepare_change` 编译出一个带
有效期和逐项跳过列表的计划，`execute_change` 按计划 id 应用它。启动项计划在
五分钟后过期，扫描之后发生变化的条目会被跳过，而不是强行执行。

## 提权

需要管理员权限的操作——机器级设置、服务、计划任务、全机卸载、注册表移除——由
同一个可执行文件以提权方式重新启动来完成，参数为 `--systools-elevation-helper`
（或 `--systools-startup-helper`、`--systools-system-settings-helper`、
`--systools-application-record-helper`）。这些参数在 Tauri 初始化之前处理，因此
辅助进程永远不会打开窗口。

辅助进程通过 loopback broker 使用换行分帧的 JSON 通信，协议 id 为
`systools-elevation-v1`，单条消息最大 64 KiB。请求携带文件路径加摘要——绝不是
命令行——因此无法诱导提权进程去执行非提权一侧没有请求的东西。

## 数据布局

```
<data dir>/systools/
├── prefs.json                    # excludedPaths, excludedNames
├── uninstall-history.json        # last 200 executions
├── leftover-history.json         # last 200
├── leftover-observations.json    # last 400
└── system-settings-recovery.json # recovery ledger, ≤1024 items, ≤1 MiB
```

扫描缓存**只在内存中**——分析索引（两个根，LRU）与重复文件哈希缓存（500 000
条）都随进程结束而消失。`prefs.json` 采用原子写入；无法解析的
`system-settings-recovery.json` 会被移动到 `.invalid.json`，并重新开始一份账本。

**没有回收站。** 删除经由 `permanent_delete`，立即释放字节。守卫只有预检、
计划预览与确认对话框——别无其他。

## 值得了解的行为

**遍历。** 排除项是绝对路径，最多 50 条，会规范化且拒绝链接，因此指向缺失文件夹
的规则仍保留其已解析的父目录，并能挺过卷被断开的情况。`should_skip` 总是跳过
`System Volume Information`、`$Recycle.Bin`、`Recovery`、`$WinReAgent` 与
`Windows\{WinSxS,Installer,System32}`；大文件与重复文件扫描还会跳过 `Windows`、
`Program Files*`、`ProgramData` 以及常见的升级残留。页面文件与休眠文件被标记为
系统关键文件，不能从这里删除。重解析点与云占位符（`OFFLINE`、`RECALL_ON_OPEN`、
`RECALL_ON_DATA_ACCESS`）从不遍历也从不打开。

**两种计量方式。** `Standard` 模式报告**已分配**字节——真实磁盘用量，硬链接会
被合并，稀疏/压缩文件按分配量计算。`Fast` 模式从元数据报告**逻辑**大小，开销
小得多。只读分析故意不跳过受保护的系统文件夹，因此其总量大于清理标签页的总量；
两者不可比较，这也是覆盖率以明确的省略桶呈现的原因（权限不足、读取错误、已排除、
链接或挂载、其他）。

**重复文件。** 枚举 → 按精确大小分组 → 从头、中、尾各取 16 KiB 样本做哈希
（blake3）→ 仅在样本碰撞处做完整哈希 → 分组。物理别名借助目录标识提示被移除，
因此硬链接不会显示为重复文件。结果按 40 分页。

**大文件。** 候选从 50 MiB 起；调用方可以提高下限。结果最多 2 000 条，跨最多
八个活动会话，对已有扫描重新设阈值不会再次遍历磁盘。

**系统优化。** 目录是编译进程序的——六个类别（性能、生产力、隐私、存储、游戏、
外观），带推荐 / 已优化 / 不可用状态，以及标准 / 谨慎 / 高风险标签。设置 id 是
不透明的（`windows.*`），映射到私有注册表标识；这里不会接受用户提供的注册表
路径。首次变更之前账本会记录原始值与优化值，只有当前值仍与账本一致时才提供还原。

**启动项。** 七个来源：每用户 Run、每用户启动文件夹、公共启动文件夹、计划任务、
服务、打包启动任务，以及一次高级 autoruns 遍历。每个条目都带有能力标记——可切换、
需要提权、仅可移除、系统托管、策略托管、或仅可查看——变更在界面中排队，编译成
计划，应用后再重新读取以报告校验后的状态。

**应用与残留。** 清单合并注册表、MSI、Appx、winget、Steam、Scoop 与 Chocolatey
的登记。卸载支持静默、交互式与外部客户端执行，支持试运行，并记录历史。残留扫描
检查卸载注册表配置单元（含 WOW64）、孤立的注册表组以及常见数据根，上限为 500 个
候选、20 秒与 200 000 个已计量条目。

**删除保护。** 卷根、驱动器根、Windows 目录、Program Files 与 shell 文件夹不能
作为清理根被拒绝；系统托管文件与任何链接背后的对象不能作为目标。

## 限制

- **仅限 Windows。** `Platform` trait 是接缝，但不存在其他适配器。
- **需要 UAC** 才能做机器级变更，且辅助进程是一次完整的重新启动。
- **删除不可逆。**
- **磁盘上没有扫描缓存**——每次启动都重新扫描。
- 分析总量包含清理标签页所跳过的系统目录。

## 把本模块接入其他应用

1. 把 `systools-core` 加入 `src-tauri/Cargo.toml`，并通过 `invoke.rs`、`build.rs`
   与 `capabilities/default.json` 暴露 `systools_*`。
2. 把 `systools` 加入能力窗口列表，并在 Tauri 初始化之前调用
   `systools_core::helper::run_from_args`。
3. 在 setup 中设置 `systools_core::paths::CONFIG_DIR`。
4. 复制 `src/pages/systools` 与 `src/lib/systools`。
5. 保留 GPL-3.0 声明，以及那 10 个字面完全一致文件的署名。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 任何 `systools_*` 调用报 "not allowed by ACL" | 未在 `build.rs` 或 `capabilities/default.json` 中注册 |
| 第二个窗口始终不出现 | 设计如此——唯一的窗口会被复用，并告知要显示哪个标签 |
| 窗口总是打开「启动项」 | `?tab=` 缺失或不是六个键之一 |
| 某个启动项切换被静默跳过 | 计划跳过了它：需要提权、目录过期（5 分钟），或条目已变化 |
| 系统优化提示该变更无法还原 | 账本缺失，或当前值已与原始值不符 |
| 分析总量远大于资源管理器 | `Standard` 模式统计已分配字节，并包含受保护的系统文件夹 |
| 扫描在云文件夹上卡住 | 占位符属性或重解析点没有被短路 |
| 保存偏好时报 "persistenceFailed" | 数据目录不可写 |
| 每次启动重复文件扫描都很慢 | 哈希缓存只在内存中 |
| 删除以 "Windows manages this file" 拒绝 | 选中的是页面文件或休眠文件 |
