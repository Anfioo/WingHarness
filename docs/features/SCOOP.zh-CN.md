# Scoop

**Scoop** 页面用来安装 Windows 上的同名包管理器，并管理它装了什么：版本、目录、
`SCOOP` / `SCOOP_GLOBAL` 环境变量、下载代理，以及已装软件与桶的清单。

它是侧边栏里的一个页面，有两种状态。磁盘上还没有安装时只显示安装页；安装完成后
出现**概览**、**搜索安装**、**桶**和**设置**四个页签。底部的运行区会显示即将执行的
完整脚本、步骤日志和运行它的终端。

## 目录、链接与环境变量

Scoop 由一个固定路径指代：

Scoop 有两个根目录，各自由一个固定链接指代：

```text
<默认配置目录>\ScoopCurrent        →  真实的 scoop 目录
<默认配置目录>\ScoopGlobalCurrent  →  真实的 scoopg 目录
```

`<默认配置目录>` 是 Tauri 解析出的目录，也就是放 `data-dir.txt` 的那个，因此用户
更改数据目录时这些链接不会移动。`SCOOP` 放的是 `ScoopCurrent`，`SCOOP_GLOBAL` 放的
是 `ScoopGlobalCurrent`。

两个真实目录各自独立选择，选项相同：

| 选项 | `SCOOP`（`scoop`） | `SCOOP_GLOBAL`（`scoopg`） |
| --- | --- | --- |
| 数据目录（默认） | `<数据目录>\scoop` | `<数据目录>\scoopg` |
| 用户目录 | `%USERPROFILE%\scoop` | `%USERPROFILE%\scoopg` |
| 自定义 | 任意绝对路径 | 任意绝对路径 |

每个所选目录都由固定链接通过目录联接（`mklink /J`）指过去。两者都不需要管理员
权限：目录联接和用户级环境变量普通进程就能创建。重新应用选项会替换对应的联接。
非空的真实目录永远不会被删除——命令会拒绝并提示用户改为选择该目录。如果所选目录
就是链接路径本身，则不创建该链接。

变量直接写入 `HKCU\Environment`，随后由一个后台 PowerShell 广播
`WM_SETTINGCHANGE`，让 Explorer 与新开的控制台重新加载环境。这个广播会等待每一个
顶层窗口，因此不被等待：准备步骤绝不能被一个卡住的窗口拖死。已经在运行的进程本来
也看不到这些变量，所以应用从不依赖 `PATH`：每次调用 Scoop 都用绝对路径
`%SCOOP%\shims\scoop.cmd`。页面提示需要重启、并提供重启按钮，只是为了让其它工具和
新开的终端也能读到这些变量。

五个命令都声明为 `#[tauri::command(async)]`，Tauri 会把它们放到线程池而不是主线程
执行。否则上面的 PowerShell 广播会与阻塞的 UI 线程互相等待，窗口就会显示“未响应”。

概览与设置页会把两个真实目录、两个 `链接 → 目录` 以及每个 `变量（真实路径 …）`
分开显示，不会再出现几行看起来一模一样的路径。

## 代理

代理有一个页面级模式——**跟随设置、直连、自定义**——默认跟随“设置 → 代理”。解析
规则与后端一致：

| 页面模式 | 实际模式 |
| --- | --- |
| 跟随设置 | 应用设置的 `none` / `system` / `custom`，system 模式还会读取 Windows 里的地址 |
| 直连 | `none`，并设置 `NO_PROXY=*` |
| 自定义 | `custom`，裸的 `host:port` 会按 `http://host:port` 处理 |

需要三条通道把代理交给 Scoop，因为没有任何一条能同时覆盖安装脚本和后续的
`scoop install`：

1. **环境变量** —— 给子进程设置 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及其小写
   形式。`git` 读的是它们。
2. **安装脚本参数** —— `install.ps1` 拿到 `-Proxy "<url>"`、`-NoProxy`，或两者都
   不传（由系统代理回答）。
3. **Scoop 自身配置** —— Scoop 的 `setup_proxy` 读取它自己的 `proxy` 设置并写入
   `[Net.WebRequest]::DefaultWebProxy`，这才是它用 PowerShell 下载时走的路。每次
   安装或搜索前，脚本先执行 `scoop config proxy <地址>`、
   `scoop config proxy none` 或 `scoop config rm proxy`。

Scoop 保存的是 `[user:pass@]host:port`，并会自己补上 `http://`，所以
`SCOOP_PROXY_ADDRESS` 是去掉协议的地址。`socks5://` 也按同样方式传入，并在日志里
提示：Scoop 本身只认识 HTTP 代理。

## 安装脚本

官方 `install.ps1` 随仓库放在 `src-tauri/resources/scoop/install.ps1`（Unlicense，
见 [THIRD_PARTY_NOTICES.zh-CN.md](../../THIRD_PARTY_NOTICES.zh-CN.md)）。它通过
`include_str!` 编进二进制，没有网络也能用；每次安装时会复制到
`<数据目录>/scoop-page/install.ps1`，所以新版应用不会继续用旧副本。

运行时不下载安装脚本。`get.scoop.sh` 只是这份文件的来源地址。

## 生成的脚本

`<数据目录>/scoop-page/` 存放一次运行需要的文件：

| 文件 | 用途 |
| --- | --- |
| `install.ps1` | 随应用附带的安装脚本，每次刷新 |
| `install.cmd` | 自己不建任何东西；运行安装脚本，然后写入代理设置 |
| `run.cmd` | 一次 `scoop install` / `scoop search` / 代理同步 |

批处理文件里只有 ASCII。路径与代理值通过子进程环境
（`%SCOOP%`、`%SCOOP_TARGET%`、`%HTTP_PROXY%`、`%SCOOP_PROXY_ADDRESS%`）传递，而不是
拼进文件，从而避免非 ASCII 用户名或目录在 `cmd.exe` 里的编码问题。为让输出可读，
脚本开头会 `chcp 65001`。

调用 `scoop.cmd` 时必须用 `call`：否则批处理会把控制权交给对方，shim 里的
`exit /b` 会在第二条命令和退出码那行之前就结束整个脚本。

每个脚本都会

- 先回显代理，以及两个链接与各自的真实目录；
- 执行工作；
- 保存 `%ERRORLEVEL%`、打印并返回它，让 PTY 的退出事件把真实状态带回页面。

页面复用现有的伪终端把脚本流式显示出来（`local_shell_start` 新增
`command` / `cwd` / `env`），因此终端界面与终端页是同一套 xterm。任何时刻只允许
一个运行任务：`run.cmd` 只有一个文件。

## 读取清单

概览不需要启动 `scoop list` 进程：

- **已装软件** —— `apps/*/current/manifest.json`（版本、描述、主页）加上
  `install.json`（桶），从 `scoop` 与 `scoopg` 两处读取；来自全局目录的软件带
  “全局”标记。`current` 是一个联接，会被透明地跟随。
- **桶** —— `scoop` 下的 `buckets/*/bucket/*.json`，按桶计数。
- **本地搜索** —— 在同一批桶目录里按文件名匹配，命中的清单再解析版本与描述。只
  搜索已克隆的桶，因此空状态会说明这一点。
- **联网搜索** —— 正常执行一次 `scoop search <词>`，输出流进终端。

安装输入接受 `7zip`、`scoop install 7zip`、`scoop install extras/vscode git`，
搜索输入也接受相同形式。词元只允许 `A-Z a-z 0-9 . - _ + / @`：结果会被
`cmd.exe` 展开，出现 shell 元字符就是命令注入。

## 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `scoop_status` | — | 安装状态、版本、路径、用户环境变量、代理、软件与桶 |
| `scoop_search` | `query` | 本地命中的桶、版本、描述与是否已安装 |
| `scoop_apply_location` | `request` | 把两个链接与变量指向所选目录，并返回新状态 |
| `scoop_prepare_install` | `request` | 创建两个目录与链接、写入变量与 `install.cmd`，返回计划 |
| `scoop_plan_run` | `request` | 为安装、搜索或代理同步写入 `run.cmd` |

`local_shell_start` 新增可选的 `command`、`cwd` 与 `env`；带上它们时执行一行命令
后退出，而不是打开交互式 shell。

## 限制

- **仅限 Windows。** `SCOOP` 是 Windows 包管理器，其它平台会直接返回错误。
- **没有卸载、更新与桶管理。** 页面负责安装、搜索与查看。`scoop uninstall` 与
  `scoop update` 只需再增加一种 `scoop_plan_run` 类型即可支持。
- **安装完成后不能在本页重指链接。** 在已有安装下改动 `SCOOP` 或 `SCOOP_GLOBAL`
  会让软件消失；设置页只读显示路径，并提示先迁移或卸载。
- **本地搜索只看到已克隆的桶。** 从未克隆的桶靠**联网搜索**发现，它会在需要时
  克隆。
- **同一时刻只有一个任务**，且没有输入：脚本不可交互。
- **系统模式使用 Windows 报告的设置**，包括 PAC 网址；Scoop 的 HTTP 代理设置无法
  按地址处理它。

## 更新内置安装脚本

1. 用上游当前文件原样替换 `src-tauri/resources/scoop/install.ps1`。
2. 在 [THIRD_PARTY_NOTICES.zh-CN.md](../../THIRD_PARTY_NOTICES.zh-CN.md) 和
   [UPSTREAM_PROJECTS.md](../UPSTREAM_PROJECTS.md) 的清单里记录新的 SHA-256。
3. 其它什么都不用改：Rust 模块在编译时把文件嵌入。
