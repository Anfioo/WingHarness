# Markdown 编辑器

## 概览

Markdown 编辑器位于 `/md-editor` 单页。文档留在磁盘原位置打开，提供多标签编辑、
实时预览、大纲，以及 HTML / 长图 / PDF 导出。

- 页面：`src/pages/md-editor/`（React 19 + Zustand，模块级单例 store）
- 编辑器：CodeMirror 6（`src/features/md-editor/editor/`）
- 引擎：`src-tauri/md-editor-core`（Rust），13 个命令在 `src-tauri/src/invoke.rs` 注册
- 前端命令封装：`src/commands/services/md-editor/`

## 数据目录

编辑器持久化的内容都在 `<数据目录>/md-editor/` 下，整个功能随数据目录一起迁移。
不使用 `localStorage`。

| 文件 | 内容 |
|------|------|
| `settings.json` | 排版、编辑行为、默认视图与导出默认值。 |
| `session.json` | 上次运行的标签、光标、滚动位置与视图模式。未命名标签不写入；最多 50 个标签。 |
| `recent.json` | 最近打开的文档，最新的在前，最多 30 条。读取时会标记已不存在的文件。 |

目录在启动时解析一次（`md-editor-core/src/paths.rs`）。

## 视图

每个标签有三种视图模式，在标签栏切换：

- **阅读** — 只显示预览；源码编辑器隐藏并以只读方式挂载。
- **源码** — 只显示编辑器。
- **分屏** — 编辑器与预览并排，中间分隔条可拖动。比例保存在 `settings.view.splitRatio`。

大纲是可选左栏（`settings.view.outlineVisible`，宽度 `settings.view.outlineWidth`）。
点击标题会把光标移到对应行，并把预览滚动到该标题。

### 滚动同步

分屏下两侧互相跟随。渲染器给每个最外层块标上 0 基的 `data-source-line`，这些配对
构成插值样本。120 毫秒的窗口抑制回声——刚滚动的一侧忽略由自己引发的另一侧滚动事件。
渲染结果变化、本地图片加载完成、尺寸变化时重建样本。

## 编辑

### 快捷键

| 按键 | 操作 |
|------|------|
| `Ctrl+N` | 新建未命名标签 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存为 |
| `Ctrl+W` | 关闭标签 |
| `Ctrl+B` / `Ctrl+I` | 加粗 / 斜体（再按一次取消包裹） |
| `Ctrl+K` | 插入链接 |
| `Ctrl+1` … `Ctrl+6` | 设置标题层级 |
| `Ctrl+F` | 查找 / 替换面板 |

macOS 上 `Ctrl` 为 `Cmd`。

### 工具栏与右键菜单

工具栏提供行内格式、标题、列表、块插入与导出菜单。动作在
`src/features/md-editor/toolbar/actions.ts` 定义一次，工具栏与编辑器右键菜单共用。

在编辑器上右键时，若点击位置不在选区范围内，光标会先移到指针处，因此每个菜单项
作用的都是点击的位置。预览的右键菜单只做剪贴板操作（复制、复制为 HTML、全选）与
导出，从不修改文档。

编辑器处于只读状态（阅读视图）时，所有编辑项自动禁用；工具栏会轮询该状态，切换视图
后立即生效。

## 预览

渲染链路：`marked` → 标题 id → `data-source-line` 标记 → highlight.js → DOMPurify
（`preview/render.ts` 的 `renderMarkdown`）。

- 标题生成 slug id，重名时追加 `-2`、`-3` 区分。
- 代码高亮有预算：全篇上限与单块上限，避免超长代码块卡住渲染。
- 本地图片通过 `md_editor_read_asset` 读取并内联为 data URL（64 条 LRU 缓存，
  关闭标签时清空）。读取失败或超出大小限制时显示占位符而不是破图。远程来源
  （`http`、`https`、`data`、`file`）交由 webview 处理。
- 超过 **500 KB 或 10 000 行**时暂停预览，面板给出提示；编辑与保存不受影响。
- 链接通过 opener 插件在外部打开，仅允许 `http` / `https`。

## 导出

三种目标，工具栏菜单与两个右键菜单都可发起：

| 目标 | 实现 | 说明 |
|------|------|------|
| HTML | 前端克隆预览 | 可选内联样式与文档标题。 |
| 长图（PNG） | SVG `foreignObject` → canvas | 可选附带大纲。当位图任一边超过 32 767 px 或总像素超过 2.68 亿时，按 0.25 步长降采样，最低 0.5×。 |
| PDF | `md_editor_export_pdf` → WebView2 `PrintToPdf` | A4 或 Letter，四边等宽页边距。渲染在临时打印 DOM 中完成，结束后移除。非 Windows，或 WebView2 运行时没有打印接口时，退化为系统打印对话框。 |

导出路径都在保存对话框里选择，不会上传任何内容。

## 设置

设置通过 `mdEditorSettingsGet` / `mdEditorSettingsSet` 一次读写。Rust 侧会对每个值
做钳制，手工改坏的 `settings.json` 不会让界面进入不可用状态。

### 外观

| 键 | 默认值 | 含义 |
|----|--------|------|
| `fontFamily` | `""` | 空表示使用应用自身的编辑器字体。 |
| `fontSize` | `14` | 编辑区与预览正文字号（px）。 |
| `lineHeight` | `1.7` | 编辑区与预览行高。 |
| `contentWidth` | `860` | 预览内容最大宽度（px），也是长图宽度。 |
| `codeFontFamily` | `""` | 空表示使用应用自身的代码字体。 |

### 编辑行为

| 键 | 默认值 | 含义 |
|----|--------|------|
| `lineWrap` | `true` | 源码编辑器自动换行。 |
| `lineNumbers` | `true` | 显示行号栏。 |
| `tabSize` | `2` | Tab 宽度。 |
| `autoSave` | `false` | 定时保存已有路径的改动标签。 |
| `autoSaveIntervalSec` | `30` | 自动保存间隔；小于 5 的值按 5 处理。 |

### 视图

| 键 | 默认值 | 含义 |
|----|--------|------|
| `defaultMode` | `split` | 新建与恢复标签的视图模式。 |
| `splitRatio` | `0.5` | 编辑区在分屏中的占比。 |
| `outlineVisible` | `true` | 显示大纲栏。 |
| `outlineWidth` | `240` | 大纲栏宽度（px）。 |

### 导出

| 键 | 默认值 | 含义 |
|----|--------|------|
| `htmlInlineStyles` | `true` | 把预览样式表内联进 HTML。 |
| `htmlIncludeTitle` | `true` | 用文档名作为 HTML 标题。 |
| `imageScale` | `2.0` | 长图像素密度。 |
| `imageIncludeOutline` | `false` | 长图旁渲染大纲。 |
| `pdfPage` | `a4` | `a4` 或 `letter`；其他值回退为 `a4`。 |
| `pdfMarginMm` | `15` | 页面四边等宽页边距（毫米）。 |

## 后端命令

| 命令 | 用途 |
|------|------|
| `md_editor_open_file` | 读取文档，识别编码与换行符。 |
| `md_editor_save_file` | 写入文档，可选按打开时的 mtime 做冲突保护。 |
| `md_editor_file_meta` | 查询路径是否存在与时间戳，不读内容。 |
| `md_editor_read_asset` | 把文档引用的图片读成 data URL。 |
| `md_editor_save_binary` | 写入二进制内容（长图 PNG）。 |
| `md_editor_export_pdf` | 通过 WebView2 把打印 DOM 渲染成 PDF。 |
| `md_editor_settings_get` / `_set` | 读取 / 写入 `settings.json`。 |
| `md_editor_recent_list` / `_add` / `_remove` | 维护 `recent.json`。 |
| `md_editor_session_get` / `_set` | 读取 / 写入 `session.json`。 |

### 限制

| 限制项 | 数值 |
|--------|------|
| 文本文件大小 | 64 MB |
| 二进制负载 | 64 MB |
| 图片资源 | 8 MB |
| 预览 | 500 KB / 10 000 行 |
| 会话标签 | 50 |
| 最近记录 | 30 |

### 错误码

`not-found`、`invalid-input`、`conflict-external-change`、`binary-file`、
`encoding-failed`、`too-large`、`unsupported`、`io`、`internal`。

失败返回 `{ code, message, detail }`。界面按错误码翻译；遇到不认识的码时显示 message。

## 未保存的改动

内容与最后一次写入不一致时标签处于未保存状态。关闭会提示保存 / 放弃 / 取消，
保存失败或被取消时标签保持打开。关闭窗口会对每个未保存标签逐一提示。

保存会带上打开时观察到的 mtime。如果文件在此期间被其他程序改动，保存会以
`conflict-external-change` 拒绝，由用户选择覆盖、另存为或取消——两个方向都不会
静默丢数据。

内存中文本始终是 `\n`；原始换行符与编码按标签保存，写入时还原。

## 许可

Markdown 编辑器移植自 TizuMark，详见 `THIRD_PARTY_NOTICES.md`。
