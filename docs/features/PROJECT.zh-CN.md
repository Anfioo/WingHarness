# 项目

「项目」页面是一个可读可写的文件浏览器与编辑器，作用于「设置 → 项目」中配置
的项目根目录。它同时也是首页，位于侧边栏中紧挨笔记页面，并且与笔记页面使用
同一个编辑器——区别只在于文件的来源。

它构建在 [codelet](https://www.npmjs.com/package/codelet) 之上：一个作为依赖
而非框架的代码编辑器。页面承载一个 `Workbench` 并向它提供 transport。标签页、
编辑器与搜索来自 codelet；Markdown 预览则是应用自己的（见
[阅读 Markdown 文件](#阅读-markdown-文件)）。

## 工作原理

```
codelet Workbench ──remote extension──▶ Transport (src/lib/editor/project-transport.ts)
   info / tree / read / write / mkdir / move / delete / source
        └─ invoke ─▶ project_fs commands (src-tauri/src/commands/project_fs.rs)
                        repo_root() = Settings → 项目 → projectRoot
                        safe_join() per path
```

transport 是唯一与应用相关的部分。其接口为 `info()`、
`tree(path, { depth, content })`、`read(path)`、`source(path)`、
`write(path, body, etag?)`、`mkdir`、`move`、`delete` 与 `watch`。页面传给
codelet 一个工厂函数 `(url) => Transport`；调用中的 `tauri://project` URL
只是占位符，并未使用。

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `project_info` | — | `{ name, version, readonly: false, maxFileSize, features }` |
| `project_tree` | `path?`, `depth?`, `content?` | 一个 `RemoteEntry`（默认 `/`，深度 1） |
| `project_read` | `path` | `{ text, etag }` |
| `project_write` | `path`, `body`, `etag?` | `{ mtime, size, etag }` |
| `project_mkdir` | `path` | — |
| `project_move` | `from`, `to` | — |
| `project_delete` | `path` | — |

## transport 强制执行的规则

**根目录来自设置。** `repo_root()` 从「设置 → 项目」读取 `projectRoot`。
为空时页面会给出提示，每次调用都以消息失败，而不会回退到某个默认目录。

**每条路径都被限制在根目录内。** `safe_join` 去掉一个前导 `/`，拒绝空段、
`.` 与 `..` 段、反斜杠、NUL 和 `:`，并断言结果仍以根目录开头。`.git` 在任何
层级都被拒绝。

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
保留其文本标签。

### 阅读 Markdown 文件

`.md` 文件仍由 codelet 的文本编辑器打开，编辑方式不变。编辑器标签栏上的
「打开预览」会打开第二个标签，用 [Markdown 编辑器](./MD_EDITOR.md) 自身的
渲染链路渲染文档——`renderMarkdown` + `PreviewPane` + `OutlinePanel`，全部随
应用打包，不从 CDN 拉取任何东西，也不下载 wasm。「打开源代码」回到文本标签，
预览右上角的图标用于显示或隐藏大纲。

该扩展是
[`markdown-preview-extension.ts`](../../src/lib/editor/markdown-preview-extension.ts)，
与[笔记](./NOTES.md)页面共用；它取代了 codelet 依赖网络的 `markdownPreview`。
文本经由 `useMarkdownPreviewDocs` 传给标签，文档中的图片按配置的
`projectRoot` 解析。

## 限制

- **没有默认根目录。** 新装时 `projectRoot` 为空，页面保持空状态，直到在
  「设置 → 项目」里配置了目录。
- **每个文件 4 MiB。** 更大的文件在树中可见，但无法打开。
- **没有监视器，没有自动保存，没有冲突合并。**
- **标签在重载后不保留。**
- `.git` 在设计上不可见；请使用 Git 仓库页面。

## 将本模块接入其他应用

1. 把 `project_fs.rs`（以及 `fs_guard.rs`）加入 commands 模块，通过
   `invoke.rs`、`build.rs` 与 `capabilities/default.json` 注册这七个命令。
2. 确保 `config::load().project_root()` 能解析——页面、文件预览与 AI 配置同步
   共用这一个设置。
3. 拷贝 `src/lib/editor/`（transport、标签存储、预览扩展、Markdown 预览扩展）
   与 `src/pages/project`。
4. 启动时把文件预览提供者指向同一个根目录，使 `preview_metadata` /
   `preview_bytes` 与编辑器一致。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| "未配置项目根目录" | 「设置 → 项目」为空 |
| 目录要展开两次才显示内容 | 该层请求失败；错误见 toast |
| 文件以二进制占位打开 | 扩展名在二进制列表中，或内容不是 UTF-8 |
| "changed on disk, reopen and edit again" | etag 变了——另一个进程写入了该文件 |
| 保存会重写整个文件 | 文件原本没有可保留的 CRLF，或编辑器把它归一了 |
| 树中缺少 `.git` | 设计上被拒绝 |
| 应用外部的修改不出现 | 没有监视器；刷新树 |
