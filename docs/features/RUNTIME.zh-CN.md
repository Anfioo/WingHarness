# 运行时安装

Clash 与 FRP 都需要一个应用本身不附带的执行文件：Clash 页用 `mihomo.exe`，FRP 控制台用
`frpc.exe`。设置窗口的 **运行时** 分区可以下载并解压其中任意一个，首次使用不再需要"自己下载、
放进正确的目录"。

同一张卡片出现在三处：

| 位置 | 安装内容 |
| --- | --- |
| 设置 → **运行时** | 两个运行时 |
| Clash 页 → **运行时** 页签 | `clash/mihomo.exe` 及其 Geo 数据 |
| FRP 页 → **运行时** 页签 | 官方 `frp/frpc.exe` 条目，不能删除 |

## 三种来源

每张卡片都提供三种安装方式，且都指向同一个官方路径——本功能不会创建额外的 frpc 记录：

1. **官方** —— `src/lib/runtime/official.ts` 中写死的压缩包地址。它是一个固定版本，而不是
   "上游最新版"，因此重新构建应用不会悄悄改变实际运行的二进制。
2. **从 URL 安装** —— 任意返回 `.7z` 或 `.zip` 的 `http(s)` 地址。
3. **从本地压缩包安装** —— 用文件选择器挑选本地 `.7z` / `.zip`。

允许覆盖已安装的运行时，文件会被替换。正在运行的 `mihomo.exe` / `frpc.exe` 无法被替换，
后端会把它作为写入错误返回。

## 文件落点

```text
<数据目录>/
├── clash/
│   ├── mihomo.exe        Clash 引擎探测并运行的程序
│   ├── geoip.dat
│   ├── geosite.dat
│   ├── geoip.metadb
│   ├── Country.mmdb
│   └── …                 clash.json、profiles/、prism/、run/ 属于功能自身
└── frp/
    ├── frpc.exe          官方运行时
    ├── README.md
    └── …                 frp.json、profiles/、logs/ 属于功能自身
```

如果压缩包把所有内容包在一个顶层目录里，会被展平：`frp_0.61.0_windows_amd64/frpc.exe`
会落到 `frp/frpc.exe`。若顶层有两个及以上条目，说明压缩包确实是树形结构，会原样保留。

FRP 安装完成后会通过 `frp_runtime_import` 登记解压出的二进制，因此立刻可用，并带着版本号
出现在 FRP 运行时列表中。Clash 运行时不需要登记：
`prism_core::store::core_binary()` 始终指向 `clash/mihomo.exe`。

## 流水线

```text
下载（moin 引擎）
  moin_add_download → 进度来自 moin:task-progress / 任务列表
  runtime_read_archive 读取完成后的文件，随后删除该任务
解压（Web Worker）
  7z-wasm `7zz x archive -oout -y -bd`
写入（Rust）
  runtime_write_file，每个文件一个 raw body
```

- **为什么用 moin？** 它本来就是应用的 HTTP 客户端：队列、代理、分段传输、重试与续传计划
  都由它负责。复用它就可以去掉仅为绕开 webview CORS 而存在的 `tauri-plugin-http`。代价是
  可见性：下载期间它就是一个普通下载任务——出现在下载页、显示进度、可能触发完成通知、
  遵循分类规则。安装器轮询该任务，读取完成后的文件，然后调用 `moin_delete_download` 与
  `moin_forget_download`，因此历史记录和磁盘上都不会留下东西。若开启了**添加时暂停**，
  任务会被立即恢复。
- **为什么用 7z-wasm？** 它与预览子系统已经为压缩包列表打包的 `7-Zip 24.09` 是同一份构建，
  `.7z` 不需要新增 Rust 依赖。worker 每次安装新建、应答后终止，因为 wasm 实例拥有自己的
  MEMFS。
- **为什么用 raw body？** 最大的官方压缩包 22 MiB，解压后约 98 MiB。把 `Vec<u8>` 当 JSON
  发送会变成数字数组。`runtime_write_file` 读取 `tauri::ipc::InvokeBody::Raw`，条目名也放在
  同一个缓冲区里：`[kind: 1 字节][名称长度: u32 LE][名称: UTF-8][内容]`。

## 安全边界

压缩包是不可信输入。`src-tauri/src/commands/runtime.rs` 在统一两种分隔符之后拒绝：

- 绝对路径、空片段、`.` 与 `..`；
- NUL 与控制字符；
- Windows 上的 `:`、结尾的点/空格，以及保留设备名（`CON`、`NUL`、`COM1` ……），
  这些都会指向与名称不同的文件；
- 首段是功能自身文件的条目：Clash 的 `clash.json`、`subscriptions.json`、`tests.json`、
  `sysproxy`、`prism/`、`profiles/`、`run/`，以及 FRP 的 `frp.json`、`profiles/`、`logs/`。

上限：读取/下载的压缩包 512 MiB，条目 256 个，解压后 1 GiB。写入先写同目录 `.tmp` 文件再
改名，安装失败不会留下写了一半的可执行文件。

## 文件

| 路径 | 职责 |
| --- | --- |
| `src/lib/runtime/official.ts` | 官方地址与每种运行时的二进制名 |
| `src/lib/runtime/install.ts` | moin 下载任务、进度、worker 生命周期、顺序写入 |
| `src/lib/runtime/extract.worker.ts` | 7z-wasm 解压、顶层目录展平、路径检查 |
| `src/components/runtime/runtime-installer.tsx` | 卡片：状态、三种来源、URL 对话框、进度 |
| `src/windows/settings/runtime-section.tsx` | 包住两张卡片的设置分区 |
| `src/commands/services/runtime/` | `runtime_target`、`runtime_read_archive`、`runtime_write_file` 的类型化封装 |
| `src-tauri/src/commands/runtime.rs` | 文件桥接：目标路径、读取压缩包、安全原子写入 |

## 新增一种运行时

需要四处：`src-tauri/src/commands/runtime.rs` 的 `RuntimeKind` 增加一个分支（目录、二进制名、
受保护条目），`OFFICIAL_RUNTIME_URLS` 增加地址，`runtimeBinaryName` 增加二进制名，以及
`src/i18n/locales/runtime/` 中两种语言的标题。卡片本身是通用的。
