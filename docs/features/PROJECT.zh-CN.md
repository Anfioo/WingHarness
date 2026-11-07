# 项目

「项目」页面是应用的起始页与项目选择页。它列出打开过的项目，并允许再打开一个；
打开的项目会获得自己的独立窗口。现在已经没有全局的单一项目——可以同时打开多个
项目，每个窗口各自作用于自己的文件夹。

项目窗口是一个可读可写的文件浏览器与编辑器，构建在
[codelet](https://www.npmjs.com/package/codelet) 之上：一个作为依赖而非框架的
代码编辑器。窗口承载一个 `Workbench` 并向它提供 transport。标签页、编辑器与搜索
来自 codelet；Markdown 预览则是应用自己的（见
[阅读 Markdown 文件](#阅读-markdown-文件)）。

## 工作原理

```
选择页 (`/`)                          项目窗口 (/project-window?path=…)
  project_recent_list                    setActiveProject(path)
  project_remember(path)                     │
  project_forget(path)                       ▼
  project_set_active(path)             codelet Workbench
  openProjectWindow(path) ──聚焦──▶      remote extension ──▶ Transport
                                            (src/lib/editor/project-transport.ts)
                                            info / tree / read / write / mkdir /
                                            move / delete / source
                                              └─ invoke ─▶ project_fs 命令
                                                           (root, path), safe_join()
```

### 选择页

`src/pages/project/index.tsx` 是 `/` 路由，本身从不展示项目。它提供路径输入框与
**浏览**按钮（对话框插件的目录选择器），下方是最近列表：名称、路径、相对时间、
搜索框，对已被删除的文件夹标出 **目录不存在**，对已有窗口的项目标出 **已打开**。

打开一个项目会先调用 `project_remember(path)`，再调用
`openProjectWindow(path)`。`project_remember` 把条目置顶并设为活动项目；真正的
工作在窗口里完成。已经打开的窗口会被聚焦而非重建，因此同一项目点两次是幂等的。

项目窗口的关闭没有任何事件通知——它只是一个普通窗口，不是插件宿主——所以页面在
挂载时与窗口获得焦点时重新扫描已打开的窗口标签。

### 项目窗口

`src/lib/project-windows.ts` 用规范化路径派生的标签创建窗口
（`hashedWindowLabel("project-", …)`），这是同一个文件夹映射到同一个窗口的原因。
路径通过查询字符串传递，因为标签是哈希；`main.tsx` 只按 pathname 路由，因此
`/project-window` 自己读取 `?path=`。

窗口绘制自己的边框（`WindowFrame` + `TitleBar`）。标题是文件夹名，返回按钮回到
选择页：它发出 `project-show-home`，由挂载在 `app-shell.tsx` 里的
`useProjectHome` 转成对 `/` 的导航，并把主窗口带到前台。

`project-*` 必须保留在 `src-tauri/capabilities/default.json` 的 `windows` 中；
能力没有授予的前缀会让窗口里的每个命令都失败。

### 根目录如何到达命令层

每个 webview 都有独立的 JavaScript 上下文，所以根目录可以放在每个窗口各自的模块
变量里：`src/commands/project-context.ts` 保存窗口的活动项目，在 workbench 挂载
时设置。`commands/services/project-fs`、`file-preview`、`shaic` 与 `database` 中的
命令包装层读取它，因此调用点保持原有签名。

workbench 在挂载时设置它、卸载时清空它——留下旧值会把另一个项目的命令发到窗口
已经不再展示的文件夹。

## 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `project_info` | `root` | `{ name, version, readonly: false, maxFileSize, features }` |
| `project_tree` | `root`, `path?`, `depth?`, `content?` | 一个 `RemoteEntry`（默认 `/`，深度 1） |
| `project_read` | `root`, `path` | `{ text, etag }` |
| `project_write` | `root`, `path`, `body`, `etag?` | `{ mtime, size, etag }` |
| `project_mkdir` | `root`, `path` | — |
| `project_move` | `root`, `from`, `to` | — |
| `project_delete` | `root`, `path` | — |

最近列表有自己的命令，由 `src-tauri/src/projects/mod.rs` 与
`src-tauri/src/commands/projects.rs` 支撑：

| 命令 | 作用 |
| --- | --- |
| `project_recent_list` | 最近列表，最近打开的在前 |
| `project_active` | 活动项目路径，没有则为 `null` |
| `project_remember(path)` | 加入最近列表并设为活动 |
| `project_forget(path)` | 从最近列表移除 |
| `project_set_active(path)` | 只切换活动项目 |

它们存放在 `<data dir>/projects.json`——与应用其余运行时状态同一目录，绝不写进
项目文件夹。路径比较时统一分隔符并忽略大小写，因此 `E:\Work` 与 `e:/work/` 是
同一个条目。列表最多保留 50 个项目。

## transport 强制执行的规则

**根目录属于窗口。** `project_fs.rs` 中的 `project_root(root)` 校验它是非空的绝对
路径且是已存在的目录。没有任何回退到全局设置的行为：没有根目录的窗口就是没有项目
的窗口。

**每条路径都被限制在根目录内。** `safe_join` 去掉一个前导 `/`，拒绝空段、
`.` 与 `..` 段、反斜杠、NUL 和 `:`，并断言结果仍以根目录开头。`.git` 在任何
层级都被拒绝，根目录下的 `.wh` 同样如此。

**树是惰性的。** `project_tree` 一次只返回一层：目录项在被下钻之前没有
`children` 字段，正因如此客户端会在展开节点时请求那一层。同一层内目录排在
文件之前，按字母序。

**二进制文件只做分类，不读取。** 基于名称的判断覆盖图片、压缩包、可执行文件、
字体、PDF 等。超过 **4 MiB** 的文件只列在树中并标记
`binary: true, truncated: true`，从不读取。`project_read` 也会拒绝非合法
UTF-8 的内容。

**换行符在保存后保持不变。** 读取时把 CRLF 归一为 LF；当磁盘上的文件原本
使用 CRLF 时，写入会重新应用 CRLF，因此保存一个文件不会重写每一行。

**并发编辑会被发现，而不会被合并。** etag 为 `"{size}-{mtime}"`。etag 不再
匹配的写入会被拒绝，提示 "changed on disk, reopen and edit again"，而不是
覆盖另一处修改。

**没有东西会自行刷新。** 没有文件监视器：`watch` 未实现，工具栏的刷新会重新
读取树。这是有意为之——监视一个正在被构建写入的工作副本，产生的噪音多于信号。

## 窗口里还有什么

workbench 带有一个 Git 活动视图（修饰标记、状态、提交面板）以及 diff、比较和
历史标签，全部都是真正的 codelet 标签。diff 由 codelet 在 iframe 中绘制，当
应用需要在其上绘制时由 React 覆盖；标签状态存放在
`src/lib/editor/editor-tabs.ts`。由于标签属于 codelet，脏点与 `Ctrl/Cmd+S`
也是 codelet 的——页面从不安装自己的 `save` 处理函数，因此保存是显式的。

[文件预览](./FILE_PREVIEW.md)模块的文件预览在这里同样注册为 codelet 扩展
（[`preview-extension.ts`](../../src/lib/editor/preview-extension.ts)）：`.docx`
或 `.png` 会作为预览标签打开，而不是 transport 会返回的占位内容。文本扩展名
保留其文本标签。预览标签会拿到本窗口的根目录。

### 阅读 Markdown 文件

`.md` 文件仍由 codelet 的文本编辑器打开，编辑方式不变。编辑器标签栏上的
「打开预览」会打开第二个标签，用 [Markdown 编辑器](./MD_EDITOR.md) 自身的
渲染链路渲染文档——`renderMarkdown` + `PreviewPane` + `OutlinePanel`，全部随
应用打包，不从 CDN 拉取任何东西，也不下载 wasm。「打开源代码」回到文本标签，
预览右上角的图标用于显示或隐藏大纲。

该扩展是
[`markdown-preview-extension.ts`](../../src/lib/editor/markdown-preview-extension.ts)，
与[笔记](./NOTES.md)页面共用；它取代了 codelet 依赖网络的 `markdownPreview`。
文本经由 `useMarkdownPreviewDocs` 传给标签，文档中的图片按本窗口的项目根解析。

### 数据库面板

活动栏中的「数据库」按钮会在文件树之上打开数据源面板，方式与提交按钮覆盖文件
树相同——再次点击关闭；两者占用同一块区域，因此互斥。面板中的每个数据源都
属于本项目：定义存放在 `<项目根>/.wh/db/data-sources.toml`，查询文件在
`<项目根>/.wh/db/query`，查询历史与行数限制也在同一目录。展开数据源即连接；
折叠分组不会断开连接，断开是一个明确的动作。

**密码从不进入项目目录。** 在面板中输入的密码写入应用级的
`<data dir>/db/secrets.json`，键为数据源的 `whp-` 前缀 id——这个前缀同时也是
把命令路由到项目自己的引擎的依据。因此保存的密码能跨检出保留，而 `.wh` 不携带
它们。

后端按根目录各保留一个项目引擎（`DbState.projects`，以规范化根目录为键的映射），
因此两个窗口的两个项目拥有各自的数据源、查询与连接，并且同时存活。

SQL 在主编辑区编辑：可以是该数据源的查询文件（命名为 `<数据源名> <n>.sql`，
停止输入 800 ms 后写回），也可以是项目中的任意 `.sql` 文件——后者由
[`sqlEditor`](../../src/features/database/project/sql-extension.ts) 扩展认领给
数据库编辑器，而不是 codelet 的文本编辑器。双击表会在同一区域打开表标签页。
结果**不**占用编辑标签：它们进入底部停靠面板的 Output、Result N 与 Plan 标签，
由运行按钮打开。

面板与[数据库页面](./DATABASE.md)共用控件——`SourceDialog`、`ObjectTree`、
`TableEditor`、`ResultTabsView`、`ConsoleEditor`——但不共用存储：`/database`
从不列出项目数据源，本面板也从不列出应用级数据源。`.wh` 已从文件树中排除，
两个视图因此不会争抢同一批文件。

## 其他页面上的项目

有三个页面在没有自己窗口的情况下也要作用于某个项目。它们在顶部各放一个
`ProjectPicker`：跨最近列表的下拉框，外加一个跳转到项目页的 **管理** 按钮。

- [文件预览](./FILE_PREVIEW.md)——浏览哪个项目的文件树。
- [AI 配置同步](./AI_CONFIG.md)——仪表盘读写哪个项目的 agent 文件。
- [数据库](./DATABASE.md)——*相对*路径的 SQLite 源按哪个项目解析，以及项目
  数据源属于哪个项目。

在选择器中的选择会设置页面的模块级活动项目，并通过 `project_set_active` 记录，
因此下一个这类页面会从上一个停下的地方开始。它们的数据源、文件与 agent 状态都会
按新项目重新读取。

没有选择器但仍需要目录的页面——Claude 对话页——从 `project_active()` 取根目录，
从未打开过项目时回退到进程自身的工作目录。

## 限制

- **没有默认项目。** 新装时最近列表为空，选择页保持空状态，直到打开一个文件夹。
- **每个文件 4 MiB。** 更大的文件在树中可见，但无法打开。
- **没有监视器，没有自动保存，没有冲突合并。**
- **标签在重载后不保留**——数据库标签也一样；但数据库连接在应用运行期间保持打开。
- `.git` 与根目录下的 `.wh` 在设计上不可见；前者请使用 Git 仓库页面，后者由数据库
  面板管理。
- **一个文件夹一个窗口。** 打开已打开的文件夹会聚焦它的窗口，而不是在同一棵树上
  再开一个。

## 将本模块接入其他应用

1. 加入 `project_fs.rs`、`fs_guard.rs`、`projects/` 与 `commands/projects.rs`，
   通过 `invoke.rs`、`build.rs`、`capabilities/default.json` 与
   `permissions/autogenerated/` 注册这十二个命令。在能力里同时授予 `project-*`
   窗口前缀。
2. 拷贝 `src/commands/project-context.ts`、`src/commands/services/projects` 与
   `src/lib/project-{routes,windows}.ts`，以及 `src/hooks/use-project-home.ts`，
   并在应用外壳中挂载 `useProjectHome`。
3. 拷贝 `src/lib/editor/`（transport、标签存储、预览扩展、Markdown 预览扩展）
   与 `src/pages/project`。
4. 从预览标签显式把根目录传给 `preview_metadata` / `preview_bytes`，使预览与
   发起它的编辑器保持一致。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| "未打开项目" | 窗口打开时没有 `?path=`，或最近列表为空 |
| 项目窗口能打开，但每个命令都被拒绝 | 能力中的 `windows` 缺少 `project-*` |
| 同一个文件夹打开两次会得到两个窗口 | 路径规范化结果不同（分隔符或大小写）；检查标签哈希 |
| 目录要展开两次才显示内容 | 该层请求失败；错误见 toast |
| 文件以二进制占位打开 | 扩展名在二进制列表中，或内容不是 UTF-8 |
| "changed on disk, reopen and edit again" | etag 变了——另一个进程写入了该文件 |
| 保存会重写整个文件 | 文件原本没有可保留的 CRLF，或编辑器把它归一了 |
| 树中缺少 `.git` | 设计上被拒绝 |
| 树中缺少根目录下的 `.wh` | 设计上被拒绝；它归数据库面板所有 |
| `.sql` 文件打开后出现数据源选择器而非文本编辑器 | 所有 `.sql` 文件都由数据库编辑器认领 |
| 数据库页面看不到项目数据源 | 两个作用域彼此独立；面板只列出本项目的 |
| 应用外部的修改不出现 | 没有监视器；刷新树 |
| 项目窗口的命令落到了另一个项目 | 窗口卸载时没有重置活动根目录；检查 `clearActiveProject` |
