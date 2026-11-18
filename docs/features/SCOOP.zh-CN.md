# Scoop

**Scoop** 页面用来安装 Windows 上的同名包管理器，并管理它装了什么：版本、目录、
`SCOOP` / `SCOOP_GLOBAL` 环境变量、下载代理，以及已装软件与桶的清单。

它是侧边栏里的一个页面，有两种状态。磁盘上还没有安装时只显示安装页；安装完成后
出现**概览**、**搜索安装**、**桶**、**托盘菜单**、**诊断**和**设置**页签。底部的
运行区会显示即将执行的完整脚本、步骤日志和运行它的终端。

**托盘菜单**页签整理托盘二级菜单：显示哪些 Scoop 快捷方式、哪些在分隔线以上，以及
它们按什么顺序排列。托盘里的**编辑托盘菜单…**打开的就是这个设置页；它的行为与数据
见 [TRAY_MENU.zh-CN.md](./TRAY_MENU.zh-CN.md)。

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

克隆桶是例外，因为它不经过 Scoop：同一个代理地址会以完整 URL 交给 libgit2 —— 系统
设置里只有 `host:port`，所以会补上 `http://` —— 而 `socks5://` 在这里是可用的。

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
| `run.cmd` | 一次 `scoop install` / `scoop search` / `scoop update` / `scoop update *` / `scoop uninstall`，或一次代理同步 |
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

## 详情面板

名字所在的行都可以点开：概览或本地搜索里的软件、桶列表里的桶。面板从右侧滑出，
显示清单或克隆里真正写着的内容，列表位置不动；内容在读取返回后填入，而不是让点击一直等着。

- **软件**：`scoop_package_info` 先在已克隆的桶里查这个名字，找不到再退回
  `apps/<名字>/current/scoop-manifest.json`。所以更新过的桶显示的是下次安装会拿到的
  版本，而早先安装的软件仍能看到自己那份清单。返回版本、已安装版本、所属桶、描述、
  主页、许可证（`"MIT"` 与 `{identifier, url}` 两种写法都认）、说明、`depends`、
  `suggests`、`bin` 安装出的命令、清单路径与清单原文。**详情**页是解析后的形式，
  **清单**页是原文，解析不出来的东西都还在那里。未安装的软件在底部带一个**安装**按钮。
- **桶**：`scoop_bucket_info` 列出该克隆下 `bucket/*.json` 的名字，以及 `git-core`
  读到的 `RepoSummary`：远程地址、分支、短哈希、提交时间与最近一次提交的标题。列表可
  筛选，点其中一项会在上面打开该软件的详情，标题栏多出返回按钮。

面板自己维护一条一到两项的路径，由被点击的那一行填入，所以「桶 → 其中一个软件」是
同一个面板，而不是两层弹窗。面板关闭或已经切到别的内容之后才返回的结果会被丢弃；
概览的 `global` 标记随行一起传下来，全局软件的已安装版本从 `scoopg` 读取。

## 克隆桶

桶就是 `<scoop>/buckets/<桶名>` 下的一个 git 克隆，这个目录**本身就是**注册信息，
`scoop bucket add` 除了三次校验之外只是一句 `git clone`。所以**桶**页直接自己克隆：
走仓库自带的 `git-core`（`git2`，libgit2 随包编译），不经过 PowerShell、不需要用户
自己装 `git.exe`，页面里的代理也真正生效。下面这一行输入接受这些写法，开头的单词都
可省略：

| 输入 | 结果 |
| --- | --- |
| `extras` | 从 `https://github.com/ScoopInstaller/Extras` 克隆为 `extras` —— 使用内置的官方桶表 |
| `extras https://github.com/ScoopInstaller/Extras` | 同上，从给定地址克隆 |
| `https://github.com/ScoopInstaller/Extras` | 桶名取仓库名并转小写 |
| `scoop bucket add extras https://github.com/ScoopInstaller/Extras` | 同上，按终端里的写法原样识别 |
| `extras/7zip` | `scoop install extras/7zip`，从已克隆的桶安装 |
| `scoop install extras/7zip` | 同上 |

裸的 `owner/repo` 一律按安装处理，而不是克隆：`scoop install` 就是这么读的，而不
写名字时用地址形式克隆桶。前端解析这一行，`scoop_add_bucket` 再解析一次，两者都
限定在桶名与 git 地址允许的字符内。

克隆完全用不到 `SCOOP`、`SCOOP_GLOBAL` 和 `.cmd` 脚本，所以运行区显示的是日志与
进度而不是终端：`scoop_add_bucket` 发出 `scoop-bucket-progress`，页面每四分之一记
一行，免得大桶的百分比把日志刷满；克隆本身的报错也写进日志。克隆返回后就刷新桶列表。Scoop
克隆前的三项校验照样保留：目录已存在、或另一个桶已经指向同一个仓库（比较时忽略
协议、结尾斜杠与 `.git`），都直接拒绝并说明原因；克隆失败会把半成品目录删掉，不
留下一个空桶。从不存在的桶安装 `<桶名>/<清单名>` 时仍会直接拦下并提示：Scoop 会
询问是否添加该桶，而终端没有输入通道。

### 删除桶

桶行上的垃圾桶按钮先要求确认，然后执行 `scoop_remove_bucket`，删掉
`<scoop>/buckets/<桶名>` 这个克隆。删除前桶名已限定为字母、数字、点、减号与下划
线，并再校验一次结果确实位于 `buckets` 之内。从该桶安装的软件仍然是安装状态、仍
然列在页面上，但那个桶的清单没了，本地搜索也就不再提供它里面的新软件。确认对话框
把这句写清楚，因为这一点最出乎意料。

一次删一个桶，任何桶都能删，包括 `main` —— Scoop 本身允许，页面就跟着允许。

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

固定不需要 Scoop 跑一条命令：`scoop hold` 只是把 `hold: true` 写进软件自己的安装
信息（`scoop-install.json`，旧版 Scoop 装的是 `install.json`），而 `scoop update *`
正是看这个标记决定跳过谁。那也正好是页面本来就要读的文件（为了拿到软件所属的桶），
所以 `scoop_set_hold` 自己写这个标记：一次文件写入，不起 PowerShell、不开终端，写完
这一行就翻转。写入方式与 Scoop 一致 —— 读出整条记录、只改或删一个键、再整条写回，
Scoop 放进去的其它字段一个不丢；旧版 Scoop 留下的 BOM 也能读。

**取消固定**是删掉这个键，而不是写 `hold: false`：只有 `true` 才算固定，`scoop unhold`
留下的 `null` 与删掉等价，页面两种都按未固定处理。命令顺带返回两个根目录刷新后的
软件列表，所以改一个标记不必重读整份清单。

被固定的行显示**已固定**徽标，**更新**按钮变为不可用：Scoop 拒绝更新被固定的软件，
所以要更新得先取消固定，而那只有一次点击。`scoop update *` 里的跳过来自 Scoop 自己，
页面不做任何过滤。

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

## 诊断 tab

四张卡片，四个问题：这台机器为 Scoop 准备好了没有、能腾出多少空间、下载缓存里是
什么、shim 里是什么。这些全部从磁盘读，只有两个会改动软件的按钮经过终端。

### 检查

`scoop_checkup` 只读，每项检查回一行。一行里带一个 **id**、是否通过、量到的值，以及
失败时能修好它的动作。句子留在页面里：后端发的是 `git` 而不是
`Git is installed`，所以一行永远不会「半翻译」，加一项检查也只需要在两份语言文件里
各加一行。

| Id | 通过条件 | 修复 |
| --- | --- | --- |
| `git` | `git --version` 退出码为 0 | 安装 `git` 软件 |
| `mainBucket` | `<scoop>/buckets/main` 是个目录 | 克隆 `ScoopInstaller/Main` |
| `developerMode` | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock` 下的 `AllowDevelopmentWithoutDevLicense` 为 `1` | 打开 `ms-settings:developers` |
| `longPaths` | `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` 下的 `LongPathsEnabled` 为 `1` | 打开 `ms-settings:developers` |
| `ntfs` | 安装目录所在的卷报的是 `NTFS` | 打开 `ms-settings:disksandvolumes` |
| `helper` | `apps/<helper>/current` 存在，`7zip`、`dark`、`innounp`、`lessmsi` 逐个看 | 安装那个软件 |

注册表和卷都是读出来的，不是起进程问出来的 —— 前者用 `windows-registry`，后者用
`GetVolumeInformationW` —— 所以一次检查只花一条 `git --version`，中文
Windows 上也照样读到 `NTFS`。**安装**和**克隆**就是页面本来就有的动作：走的是同一份
安装计划和同一个克隆，连代理都一样，日志与终端也是那一个。**打开设置**是
`scoop_open_settings`，它把固定的 `ms-settings:` 地址交给 `explorer.exe`；命令只接受
`developers` 和 `disksandvolumes`，别的一律拒绝，因为那个值会一路走到 shell。

### 清理

一张卡片背后是两套机制，因为这是两个不同的问题：

- **旧版本**跑 `scoop cleanup *`，也就是 Scoop 自己按根目录扫的那条命令；全局根里有
  软件、且用户级那一遍跑到了，就在后面追加 `scoop cleanup -g *`。它和其它运行一样，
  结果在终端里。
- **过期的下载**由页面自己做。`scoop cache rm *` 会把所有文件一起带走，包括一个软件
  装过好几个版本、切换时还要用的那些，所以 `scoop_cache_clear(…, outdatedOnly)` 拿
  每个文件的版本和已装的版本比，只删过期的。

### 下载缓存

`scoop_cache_entries` 自己读 `<scoop>/cache`。Scoop 把每个文件命名成
`name#version#hash.ext`，页面要显示的软件、版本和大小全在里面，不必再问 CLI；目录总量
就是列出来的那些之和。装过多个版本的软件 —— `apps/<app>` 里在 `current` 旁边还有别的
版本目录 —— 会被标成 **多版本**，它的文件在这里删不掉：切换版本正需要它们。
`scoop_cache_clear` 把这种文件算作 `skipped` 而不是悄悄跳过，行上的删除按钮也置灰并
把原因写在提示里。

### shim

`scoop_shims` 走 `shims` 和 `global/shims`。一行是一个名字：`.shim` 文件说明跑什么
（`path`、`args`），旁边那个 `.exe` 是 Scoop 启动器的副本，所以启动器和它的
`.exe.shimmed` 孪生文件会被折进这一行，而不单独列出。所有动作都是文件操作，所以一个
都不需要终端：

- **隐藏 / 显示**把 `<name>.exe` 改名成 `<name>.exe.shimmed` 再改回来 —— Scoop 自己
  就是把命令从 `PATH` 里拿掉而不删 shim 的。
- **删除**删掉所有以 `<name>.` 开头的文件 —— 那个点正是让 `dark` 不会连带删掉
  `darktable` 的东西。
- **添加**写 `.shim` 文件，并把 `apps/scoop/current/shim.exe` 复制到它旁边，本地根或
  全局根都行。

### 署名

设置 tab 最后一张卡片说的是 WingHarness 而不是 Scoop：软件名、`getVersion()` 拿到的
版本、`AGPL-3.0-only` 许可证、作者和源码仓库的链接，再加一个和「关于」窗口同样的更新
检查。它刻意不做成进那个窗口的第二个入口 —— 它需要的两个按钮各自就是一次调用。

## 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `scoop_installed` | — | 固定目录里是否有 Scoop，只看该路径 |
| `scoop_status` | — | 安装状态、版本、路径、用户环境变量、代理、软件与桶 |
| `scoop_search` | `query` | 本地命中的桶、版本、描述与是否已安装 |
| `scoop_apply_location` | `request` | 把两个链接与变量指向所选目录，并返回新状态 |
| `scoop_prepare_install` | `request` | 创建两个目录与链接、写入变量与 `install.cmd`，返回计划 |
| `scoop_plan_run` | `request` | 为安装、搜索、代理同步、`scoop update`、`scoop update *`、单个软件更新、`scoop cleanup *` 或卸载写入 `run.cmd` |
| `scoop_set_hold` | `name`、`global`、`hold` | 在软件自己的安装信息里写入或清除固定标记；返回两个根目录刷新后的软件列表 |
| `scoop_add_bucket` | `request` | 用 `git-core` 把桶克隆到 `<scoop>/buckets/<桶名>`，代理来自本页；返回桶名、目录与日志 |
| `scoop_remove_bucket` | `spec` | 删除 `<scoop>/buckets/<桶名>`；返回桶名、目录与日志 |
| `scoop_package_info` | `name`、`bucket`、`global` | 从已克隆的桶或已安装的软件读取一份清单：版本、许可证、说明、依赖、建议、命令、路径与原文 |
| `scoop_bucket_info` | `name` | 该桶的 `bucket/*.json` 名称，以及克隆的远程地址、分支、提交、提交时间与最近提交标题 |
| `scoop_checkup` | — | 每项检查一行：id、是否通过、量到的值，失败时还有修复动作 |
| `scoop_open_settings` | `page` | 打开 `ms-settings:developers` 或 `ms-settings:disksandvolumes` |
| `scoop_cache_entries` | — | 把 `<scoop>\cache` 读成文件：软件、版本、大小，以及是否属于多版本软件 |
| `scoop_cache_clear` | `files`、`outdatedOnly` | 删除指定文件、只删过期的、或全删；返回腾出的字节、跳过的文件与失败项 |
| `scoop_shims` | — | 本地与全局的 shim：名字、目标、所属软件、参数、是否全局、是否隐藏 |
| `scoop_shim_add` | `request` | 写入 `<name>.shim` 并复制一份 `shim.exe`；返回刷新后的列表 |
| `scoop_shim_toggle` | `name` | 改启动器的名字来隐藏或显示 shim；返回刷新后的列表 |
| `scoop_shim_remove` | `name` | 删掉这个 shim 的所有文件；返回刷新后的列表 |

`local_shell_start` 新增可选的 `command`、`cwd` 与 `env`；带上它们时执行一行命令
后退出，而不是打开交互式 shell。

## 限制

- **仅限 Windows。** `SCOOP` 是 Windows 包管理器，其它平台会直接返回错误。
- **安装完成后不能在本页重指链接。** 在已有安装下改动 `SCOOP` 或 `SCOOP_GLOBAL`
  会让软件消失；设置页只读显示路径，并提示先迁移或卸载。
- **本地搜索只看到已克隆的桶。** 从未克隆的桶靠**联网搜索**发现，它会在需要时
  克隆。
- **同一时刻只有一个任务**，且没有输入：脚本不可交互。
- **`scoop cleanup -g *` 需要管理员窗口**，和 `scoop update -g *` 一模一样，所以在
  普通窗口里发起的全局清扫会在终端里报出它的拒绝，全局根保持原样。
- **缓存与 shim 的改动是文件操作**，由本页做而不是 `scoop cache rm` 和 `scoop shim`，
  所以跟着的是 Scoop 的目录结构而不是它的代码：多版本软件的下载在缓存管理里永远删不
  掉，从这里加的 shim 也不会登记到别处。
- **系统模式使用 Windows 报告的设置**，包括 PAC 网址；Scoop 的 HTTP 代理设置无法
  按地址处理它。

## 更新内置安装脚本

1. 用上游当前文件原样替换 `src-tauri/resources/scoop/install.ps1`。
2. 在 [THIRD_PARTY_NOTICES.zh-CN.md](../../THIRD_PARTY_NOTICES.zh-CN.md) 和
   [UPSTREAM_PROJECTS.md](../UPSTREAM_PROJECTS.md) 的清单里记录新的 SHA-256。
3. 其它什么都不用改：Rust 模块在编译时把文件嵌入。
