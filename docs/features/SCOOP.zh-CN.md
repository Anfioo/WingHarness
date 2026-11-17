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

在概览页，只要两个变量都指向各自的固定链接（也就是安装正常的状态），这张卡片就折叠
成一行：打开这个页面要看的是已安装的软件列表。这一行带**已就绪**徽标，箭头点开即可；
一旦某个变量缺失或指向别处，它会自己展开，因为那时它才是该看的东西。手动开关在页面
打开期间优先于这个默认。

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

### 以管理员身份运行

安装脚本检测到管理员令牌时会直接退出，输出
`Running the installer as administrator is disabled by default`。它和“管理员**账户**”
不是一回事：从管理员账户启动的普通进程拿的是受限令牌，可以正常安装。真正触发的
是整个会话本身已经提权——关掉了 UAC，或以管理员身份启动了 WingHarness。

所以安装界面多了一个开关**以管理员身份运行安装脚本**，默认关闭。打开后只是给
PowerShell 调用加上 `-RunAsAdmin`，别的不变：Scoop 仍然装进上面选的两个目录，开关
和其它页面偏好一起记住。这次到底怎么跑的也会写进运行日志（`Installer runs as: …`），
终端里能直接看到。

## 生成的脚本

`<数据目录>/scoop-page/` 存放一次运行需要的文件：

| 文件 | 用途 |
| --- | --- |
| `install.ps1` | 随应用附带的安装脚本，每次刷新 |
| `install.cmd` | 自己不建任何东西；运行安装脚本，然后写入代理设置 |
| `run.cmd` | 一次 `scoop install` / `scoop search` / `scoop bucket add` / `scoop bucket rm` / `scoop update` / `scoop update *` / `scoop hold` / `scoop uninstall`，或一次代理同步 |
| `scoop-run.ps1` | 每一次 Scoop 调用都经过的包装脚本 |

批处理文件里只有 ASCII。路径与代理值通过子进程环境
（`%SCOOP%`、`%SCOOP_TARGET%`、`%HTTP_PROXY%`、`%SCOOP_PROXY_ADDRESS%`、
`%SCOOP_WRAPPER%`）传递，而不是拼进文件，从而避免非 ASCII 用户名或目录在
`cmd.exe` 里的编码问题。为让输出可读，脚本开头会 `chcp 65001`。

Scoop 本身是 PowerShell，所以调用不可能纯 `cmd`；脚本固定的是**宿主**。它们调用
`powershell.exe -File "%SCOOP_WRAPPER%" …`，而不是 `%SCOOP%\shims\scoop.cmd`：
后者的宿主由 `where /q pwsh.exe` 自行决定，同一台机器会跑在 `PATH` 上碰到的任意
PowerShell 上；而且它会吞掉退出码 —— Scoop 的 `exec` 是 `& $path @args`，状态只落到
`$LASTEXITCODE`，于是失败之后 shim 仍然退出 `0`。Windows PowerShell 5.1 始终存在，
安装脚本本来也用它，因此包装脚本两者兼得：固定宿主，以及真实状态。

包装脚本在退出前先用 `Out-String -Stream` 把命令输出格式化。`scoop bucket list`
这类表格之所以还能看见，靠的就是这一步：裸的 `exit` 会在格式化器仍持有对象时结束
进程。

每个脚本都会

- 先回显代理，以及两个链接与各自的真实目录；
- 执行工作；
- 保存 `%ERRORLEVEL%`、打印并返回它，让 PTY 的退出事件把真实状态带回页面。

页面复用现有的伪终端把脚本流式显示出来（`local_shell_start` 新增
`command` / `cwd` / `env`），因此终端界面与终端页是同一套 xterm。任何时刻只允许
一个运行任务：`run.cmd` 只有一个文件。

## 读取清单

概览不需要启动 `scoop list` 进程。页面靠两次读取打开：`scoop_installed` 只看固定目录，
毫秒级回答“已安装”，所以徽标和页签行第一帧就是对的；`scoop_status` 要遍历每个桶、
每个已装清单再问一次 CLI 版本，等它回来后再覆盖那个预判。加载屏按页面本身的形状画
（页签行、三个计数卡、路径卡与软件卡），而不是一整块。

- **已装软件** —— `apps/*/current/scoop-manifest.json`（版本、描述、主页）加上
  `scoop-install.json`（桶），从 `scoop` 与 `scoopg` 两处读取；来自全局目录的软件带
  “全局”标记。`current` 是一个联接，会被透明地跟随。这两个是当前 Scoop 写下的文件名；
  旧版 Scoop 装的软件仍带着 `manifest.json` 与 `install.json`，所以每处读取都会回退到
  旧名字，两种安装都能显示出各自的版本号。名字以 `wingharness-` 开头的软件旁边会多一个
  **WingHarness 插件**徽标——名字是插件唯一的标记（见
  [PLUGINS.zh-CN.md](./PLUGINS.zh-CN.md#1a-名字wingharness-name)）。
- **桶** —— `scoop` 下的 `buckets/*/bucket/*.json`，按桶计数。
- **本地搜索** —— 在同一批桶目录里按文件名匹配，命中的清单再解析版本与描述。只
  搜索已克隆的桶，因此空状态会说明这一点。命中的名字带插件前缀时同样带徽标，所以
  还没安装就能认出这是插件。
- **联网搜索** —— 正常执行一次 `scoop search <词>`，输出流进终端。

安装输入接受 `7zip`、`scoop install 7zip`、`scoop install extras/vscode git`，
搜索输入也接受相同形式。词元只允许 `A-Z a-z 0-9 . - _ + / @`：结果会被
`cmd.exe` 展开，出现 shell 元字符就是命令注入。

## 克隆桶

**桶**页用 `scoop bucket add` 克隆桶；下面这一行输入接受这些写法，开头的单词都可
省略：

| 输入 | 结果 |
| --- | --- |
| `extras` | `scoop bucket add extras https://github.com/ScoopInstaller/Extras` —— 使用内置的官方桶表 |
| `extras https://github.com/ScoopInstaller/Extras` | `scoop bucket add extras …` |
| `https://github.com/ScoopInstaller/Extras` | 桶名取仓库名并转小写 |
| `scoop bucket add extras https://github.com/ScoopInstaller/Extras` | 同上，按终端里的写法原样识别 |
| `extras/7zip` | `scoop install extras/7zip`，从已克隆的桶安装 |
| `scoop install extras/7zip` | 同上 |

裸的 `owner/repo` 一律按安装处理，而不是克隆：`scoop install` 就是这么读的，而不
写名字时用地址形式克隆桶。前端解析这一行，后端在写 `run.cmd` 之前再解析一次
—— 桶名与地址通过子进程环境变量传入并加引号，两者都限定在桶名与 git 地址允许的
字符内。

克隆任务以 0 退出时会刷新桶列表。从不存在的桶安装 `<桶名>/<清单名>` 时会直接拦下
并提示：Scoop 会询问是否添加该桶，而终端没有输入通道。

### 删除桶

桶行上的垃圾桶按钮先要求确认，然后执行 `scoop bucket rm <桶名>`，删掉
`<scoop>/buckets/<桶名>` 这个克隆。Scoop 只删目录和它的缓存条目，别的都不动：从该
桶安装的软件仍然是安装状态、仍然列在页面上，但那个桶的清单没了，本地搜索也就不再
提供它里面的新软件。确认对话框把这句写清楚，因为这一点最出乎意料。

一次运行删一个桶，任何桶都能删，包括 `main` —— Scoop 本身允许，页面就跟着允许。

## 更新清单与软件

更新由两个按钮覆盖，各在一个页签里，各自就是一条 Scoop 命令：

| 按钮 | 位置 | 命令 | 更新什么 |
| --- | --- | --- | --- |
| **更新全部桶** | 桶页签表头 | `scoop update` | Scoop 本体与所有已克隆的桶 |
| **全部更新** | 概览页软件表头 | `scoop update *` | 所有用户级（非全局）软件 |
| **更新**（行内） | 概览页的软件行 | `scoop update <app>` | 这一个软件 |

桶是 `<scoop>/buckets/<桶名>` 下的 git 克隆，而 Scoop 没有“只更新一个桶”的命令，
所以不提供单桶更新 —— 命令既然只有 `scoop update`，就一次更新全部。

全局目录里有软件时，“全部更新”会在同一个脚本末尾补一条 `scoop update -g *`，
并在用户级那一遍失败时停下、不再执行它。Scoop 要求这一遍在管理员窗口里运行，
所以在普通窗口里启动的运行会在终端里显示它的拒绝，全局软件保持原样。全局软件的
行内更新同样带 `-g`。

### 固定版本

行内的**固定版本**执行 `scoop hold <app>`，**取消固定**执行 `scoop unhold <app>`。
Scoop 把固定写成软件自己安装信息里的 `hold: true`（`scoop-install.json`，旧安装是
`install.json`），此后每次 `scoop update *` 都会跳过它 —— 跳过是 Scoop 自己做的，
页面不做任何过滤。该行随后显示**已固定**徽标，**更新**按钮变为不可用：Scoop 拒绝
更新被固定的软件，所以要更新得先取消固定，而那只有一次点击。

页面直接读那个文件里的标记，不启动 `scoop` 进程，所以状态一到徽标就是准的；固定
任务以 0 退出时会刷新状态，徽标随之翻转。

## 卸载软件

已安装软件行上的垃圾桶按钮先要求确认，然后执行 `scoop uninstall <app>`，全局软件
再带上 `-g`。一次运行卸载一个软件，WingHarness 插件也走同一条路 —— 插件本身就是
普通的 Scoop 软件。

Scoop 默认保留 `<scoop>/persist/<app>` 目录，软件的设置就放在那里，重装时还能接上。
确认对话框里的**同时删除 persist 目录**会追加 `-p`，做一次彻底删除。这个选项只对
本次运行有效，每次打开对话框都会重置，所以危险的选项不会被默认勾着。

对话框正文写明 persist 的去向，运行日志里也再写一遍，所以一次运行做什么，在开始前
和开始后都看得见。

`scoop uninstall scoop` 会连 Scoop 本体和它装的所有软件一起删掉，所以
`scoop_plan_run` 直接拒绝这个名字，而不是把它当作可选目标。

## 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `scoop_installed` | — | 固定目录里是否有 Scoop，只看该路径 |
| `scoop_status` | — | 安装状态、版本、路径、用户环境变量、代理、软件与桶 |
| `scoop_search` | `query` | 本地命中的桶、版本、描述与是否已安装 |
| `scoop_apply_location` | `request` | 把两个链接与变量指向所选目录，并返回新状态 |
| `scoop_prepare_install` | `request` | 创建两个目录与链接、写入变量与 `install.cmd`，返回计划 |
| `scoop_plan_run` | `request` | 为安装、搜索、克隆或删除桶、代理同步、`scoop update`、`scoop update *`、单个软件更新、固定/取消固定或卸载写入 `run.cmd` |

`local_shell_start` 新增可选的 `command`、`cwd` 与 `env`；带上它们时执行一行命令
后退出，而不是打开交互式 shell。

## 限制

- **仅限 Windows。** `SCOOP` 是 Windows 包管理器，其它平台会直接返回错误。
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
