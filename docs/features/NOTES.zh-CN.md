# 笔记

「笔记」页面是 Markdown 笔记——每场会议、每个任务或每个想法一个文件。它位于
侧边栏「Agent」分组下，使用与[项目](./PROJECT.md)页面相同的编辑器；区别只在
文件来源。项目页面编辑工作副本，笔记则编辑数据目录中的一个私有文件夹。

笔记是磁盘上的普通文件。没有任何内容存放在数据库里，因此任何编辑器都能打开
它们，备份就是复制文件夹。

## 笔记的位置

```
<data dir>/notes/
├── welcome.md
└── …            # 用户创建的任何嵌套层级
```

`<data dir>` 是可配置的数据目录（设置 → 数据目录）；移动它也就移动了笔记。
`notes_list` 递归遍历该文件夹，返回文件及其内容与目录列表，均采用以 `/` 为根
的 POSIX 形式。非合法 UTF-8 的文件会被静默跳过，符号链接则被忽略。

## 工作原理

```
codelet Workbench ── in-memory FileSystem ──▶ notes store (src/pages/notes/store.ts)
       ▲                                              │
       └── loadWorkspace: notes_list ─────────────────┘

fs.onDidChange ── debounce 500 ms ──▶ reconcileOnce(fs)
    notes_write for every file whose text differs
    notes_mkdir  for every new directory
    notes_delete for every file gone from memory
    notes_delete for directories, deepest first
```

每一轮都协调整棵树，而不是逐条应用变更，因为目录重命名会为两个名字抛出一次
事件，而对随之移动的子项完全不抛事件。一个 running/again 闩锁把重叠的轮次
串行化，因此一阵连续编辑最终每个文件仍只写一次。

首次运行会种下 `welcome.md` 并立即写入，因此文件夹不会为空。

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `notes_list` | — | `{ files: [{ path, content }], directories: [] }` |
| `notes_write` | `path`, `content` | — |
| `notes_mkdir` | `path` | — |
| `notes_delete` | `path` | —（针对目录时递归） |
| `notes_rename` | `from`, `to` | — |

每条路径都经过与项目页面相同的 `safe_join` 限制。

`notes_rename` 已导出但未使用：页面在内存中重命名，交由协调器删除并重建。
把它接回来可以省去每次重命名的一次写入，但必须处理随文件夹一起移动的子项。

## 页面提供的内容

带搜索、扩展视图、Markdown 预览与文件预览扩展的 codelet workbench。左侧文件
树，中间标签页，面板可拖动。默认打开第一条笔记。

### 阅读笔记

`.md` 文件仍由 codelet 的文本编辑器打开，编辑方式不变。编辑器标签栏上的
「打开预览」会打开第二个标签渲染同一文档，「打开源代码」则回到文本标签。

渲染用的是 [Markdown 编辑器](./MD_EDITOR.md) 自身的那一套：`renderMarkdown`
（marked + DOMPurify + highlight.js）与 `PreviewPane`（KaTeX、Mermaid、本地
图片），旁边是文档大纲。这些都随应用一起打包，因此预览不需要网络。它取代了
codelet 的 `markdownPreview`——后者在运行时从 `esm.sh` 拉取 `md4x` 及其
wasm。

编辑时预览会跟随缓冲区：扩展（`src/lib/editor/markdown-preview-extension.ts`）
在每次变更时把每个已打开文档的文本写入 `useMarkdownPreviewDocs`，标签页
（`src/lib/editor/markdown-preview-tab.tsx`）在 150 ms 停顿后渲染。文本经由
该 store 而不是标签页的 surface 描述符传递，因此一次按键不会重建标签栏。图片
按 `<data dir>/notes` 解析，预览右上角的图标用于显示或隐藏大纲。

workbench 把打开与激活的标签保存在 refs 中，因此切换扩展视图或切换 UI 语言
（两者都会重新挂载外壳）不会丢失缓冲区。编辑器偏好（字体、主题、行号、扩展
视图）与项目页面共享，存放在 `localStorage` 的 `editor-prefs` 键中。

## 限制

- **后写者胜。** 没有 etag，也没有合并。若笔记在页面持有过期缓冲区时被另一个
  编辑器修改，页面的下一次保存会覆盖它。
- **磁盘变化只在加载时可见。** 没有监视器，页面加载后才出现在磁盘上的文件会
  在下一次协调时被**删除**，因为在 store 看来它并不存在。
- **所有内容都在启动时读取。** `notes_list` 返回每个文件的完整内容，因此存放
  大文件的 `notes` 文件夹会消耗内存与加载时间。
- **UI 状态不持久化。** 打开的标签能挺过重新挂载，但挺不过重载。
- 删除笔记或文件夹是即时的——树 UI 自带的确认是唯一的防线。

## 将本模块接入其他应用

1. 把 `notes.rs` 加入 commands 模块，并通过 `invoke.rs`、`build.rs` 与
   `capabilities/default.json` 注册这五个命令。
2. 拷贝 `src/pages/notes`——它依赖 `src/lib/editor`、文件预览扩展与 Markdown
   预览扩展，而项目页面同样需要这些。
3. 没有别的步骤：文件夹会在数据目录下按需创建。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| "笔记保存失败，请检查数据目录是否可写" | 数据目录只读，或文件夹在应用运行期间被删除 |
| 另一个程序写入的笔记消失 | 协调器把未知文件视为已删除——先重新加载 |
| 树中缺少某条笔记 | 它不是合法 UTF-8，或者是符号链接 |
| 两个窗口中的编辑互相覆盖 | 两个窗口各自独立协调；后写者胜 |
| 首次启动时编辑器为空 | `welcome.md` 写入失败——检查数据目录 |
