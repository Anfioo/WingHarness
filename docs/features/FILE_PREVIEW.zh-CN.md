# 文件预览

**文件预览**页用来查看某个项目里的文件。
它位于侧边栏「笔记」之后，作用于页面顶部项目选择器所选中的项目——也就是
**项目**页在窗口中打开的同一个文件夹，由后端限制在该目录之内。文本类文件也可以
直接编辑，其余格式只作展示。

## 工作原理

```
┌─ 页面 ──────────────────────────────────────────────────────────────┐
│  FileTree（project_tree，每次展开读一层目录）                        │
│  PreviewPane ── preview_metadata / preview_bytes ──▶ 字节           │
│                └─ loadPreview(metadata, url, signal) ──▶ LoadState  │
│                      └─ registry → 动态 import(...renderer) ──▶ Preview │
└─────────────────────────────────────────────────────────────────────┘
```

- **后端只负责读字节。** 所有解析都在 webview 里完成（pdf.js、exceljs、mammoth、
  pptxviewjs、7z-wasm 等）。Rust 端是独立的 crate
  [`src-tauri/file-preview-core`](../../src-tauri/file-preview-core)，只暴露两个命令。
- **文件树按需加载。** `project_tree` 一次只返回一层目录，因此一个装着 `.git`、
  `node_modules` 与构建产物的项目，成本只等于屏幕上真实显示的部分。
  `.git` 从不对外提供。
- **渲染器天然分包。** 每种格式都是 `await import('./xxxRenderer')`，从未预览过
  表格的窗口也就不会加载 exceljs。
- **UI 用宿主自己的。** 页面、文件树与工具栏都是 shadcn/ui + Tailwind；viewer
  自己的 CSS 限定在 `.ov-preview` 之下，因此它对裸 `button` 的样式不会影响到
  应用其它部分。

## 命令

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `preview_metadata` | `path`、`root` | `PreviewMeta` | `/` 开头的相对路径；含大小、mime、`previewable`、`overCap` |
| `preview_bytes` | `path`、`root` | Raw IPC 字节 | 超出配置的阈值、或不在项目根目录之内时拒绝 |

`path` 始终是根相对、`/` 开头的形式，与文件树使用的写法一致。`root` 由调用方传入：
页面传选择器选中的项目，项目窗口传自己的文件夹，笔记页传笔记目录——因此预览读取的
位置始终就是列出该文件的位置。

文件大小阈值在每次调用时从 `config.json` 读取（`filePreview.maxBytes`），因此在
**设置 → 文件预览设置**里改完，下一份打开的文件立即生效，无需重启。默认 64 MiB；
设置页提供 1 MiB–1 GiB 的范围，后端按同一范围收紧，避免手改过的配置要求 webview
装下整块磁盘。

## 支持的格式

| 类别 | 扩展名 |
|------|--------|
| Word | `docx docm dotx dotm odt ott fodt rtf` |
| 表格 | `xls xlsx xlsm xltx xltm csv tsv ods ots fods` |
| 演示 | `pptx pptm ppsx ppsm potx potm odp otp fodp` |
| PDF | `pdf` |
| 图片 | `png jpg jpeg pjp pjpeg gif webp bmp ico avif apng cur tif tiff icns` |
| 矢量 / 字体 | `svg svgz ttf otf woff woff2` |
| 压缩包 | `zip crx jar vsix apk tar tgz tar.gz 7z rar` |
| 电子书 | `epub fb2 cbz` |
| 可视化 | `xmind psd` |
| 邮件 | `eml` |
| 音视频 | `mp3 wav ogg oga opus flac m4a aac` / `mp4 m4v webm ogv mov` |
| 文本 / 代码 / 标记 | `md markdown html htm xhtml json yaml yml xml toml txt log` 及常见源码扩展名 |

其余格式回退到文本探测；字节不是文本时显示「不支持预览此文件」。

## 设置

**设置 → 文件预览设置**集中了本页读取的两个选项，两者都存放在 `config.json`
的 `filePreview` 之下：

- **文件大小阈值** — `maxBytes`，按字节存储，页面上以 MB 显示。
- **语法高亮** — `highlight`，同时作用于文本预览和编辑器，本页以及**项目**、
  **笔记**两页的预览标签都算。

这些设置区共用 `useConfigDraft`：最后一次修改后 400 ms 自动保存，随后发出
`config-changed` 事件；`useFilePreviewConfig` 监听该事件，因此已经打开的预览窗口
无需刷新就会按新设置重绘。

## 编辑

工具栏上的铅笔按钮会用轻量编辑器打开原始文件。只有 viewer 把该文件当作文本处理时
才会出现——Markdown、JSON/YAML/XML/TOML、源代码、日志——或者回退逻辑把字节识别成
了文本；超过阈值的文件永远不出现。表格、文档、图片保持只读。

- **编辑器不是 codelet。** 它是
  [`src/components/code-editor.tsx`](../../src/components/code-editor.tsx)：透明文字
  的 textarea 叠在高亮后的 `<pre>` 上，这套做法最初来自 Clash 设置页。光标、选区、
  撤销与输入法都还是原生的；高亮走 `useDeferredValue`，不挡输入路径，文本超过
  200 000 字符时直接不开启。Clash 页现在是同一个组件的另一个调用方。
- **读的是原始文本，不是预览结果。** 编辑器通过 `project_read` 读取，因此 Markdown
  按 Markdown 编辑，而不是编辑渲染后的 HTML；JSON 读的是文件原样，而不是 viewer
  打印出来的缩进副本。
- **保存采用比较后写入。** `project_write` 会带上读取时的 etag，若文件在这期间被
  磁盘上的改动覆盖则拒绝写入；错误以 toast 呈现，文本留在编辑器里。CRLF 文件保留
  原有换行符。
- **Ctrl/Cmd+S** 不离开键盘即可保存；**Tab** 插入两个空格。工具栏上的圆点表示有
  未保存的修改；此时选择另一个文件或项目、或者点**退出编辑**，都会先询问是否放弃。
- **高亮跟随文件名。** `languageOf` 把路径映射到
  [`src/lib/git-core/highlight.ts`](../../src/lib/git-core/highlight.ts) 注册的
  highlight.js 语法；未知扩展名按纯文本处理。

## 速览

按 `空格`——或者**设置 → 快捷键 → 文件速览**里设置的任一触发方式——会在独立窗口
里打开选中的条目，页面本身留在原处。文件会把该窗口填满成单独的预览面板；文件夹
则显示文件树并在右侧带一个预览，打开时已展开到该文件夹。

- **只在应用内生效，不是系统全局快捷键。** 空格、双击 Ctrl、Alt+空格、Win+空格
  无法注册到全局快捷键插件而不从其他所有程序手里抢走这些按键，因此由文件预览页
  自己匹配：仅在窗口获得焦点、且光标不在输入框里时响应。这与系统文件管理器的
  空格速览一致。
- **触发方式是同一个字符串。** 预设（`preset:space`、`preset:doubleCtrl`、
  `preset:altSpace`、`preset:winSpace`）或在「显示主窗口」同一套
  [`ShortcutField`](../../src/components/shortcut-field.tsx) 里挑选的组合键，都存在
  `config.json` 的 `shortcuts.quickPreview` 之下。`useShortcutConfig` 监听
  `config-changed`，因此在设置窗口里改完，下一次按键就按新值响应。
- **什么都不保存。** 这个窗口是临时性的：关闭即销毁，既不会成为项目，也不会成为
  标签页。[`src/lib/quick-preview.ts`](../../src/lib/quick-preview.ts) 通过
  `createWindow` 以 `alwaysOnTop` 打开它；已经存在的窗口会被重新显示，并通过
  `quick-preview-open` 事件收到新的目标，因为复用的窗口会保留创建时的 URL。
- **Esc 关闭。** [`src/pages/quick-preview/index.tsx`](../../src/pages/quick-preview/index.tsx)
  是它的路由（`/quick-preview`，窗口标签 `quick-preview`），已列在
  `capabilities/default.json` 中，因此它调用的命令能通过 ACL。它复用 `FileTree`
  与 `PreviewTab`，解析文件的方式与本页完全相同——但只是速览，不提供编辑。

## 在编辑器里

同一套 viewer 也注册成了 codelet 扩展
（[`src/lib/editor/preview-extension.ts`](../../src/lib/editor/preview-extension.ts)），
**笔记**与**项目**两页都会挂载：文本编辑器读不了的文件——`.docx`、`.png`——
于是以预览打开，而不是只拿到 transport 写下的占位符。

- 只接管文本编辑器做得更差的那部分格式。列在 `TEXT_EXTENSIONS` 里的扩展名
  （Markdown、JSON、TOML、常见源码扩展名、`csv`、`tsv`、`svg`、HTML）仍归文本
  编辑器；registry 里其余格式由一条生成出来的 `**/*.{…}` 选择器全数接管，因此往
  `registry.ts` 里新增渲染器时这里也自动生效。
- 面板自身不画任何东西：扩展只把打开的路径转给宿主，由宿主的
  [`PreviewTab`](../../src/components/file-preview/preview-tab.tsx) 盖住工作台，
  并按本页一模一样的顺序加载——同一个 `PreviewPane`、同一套 viewer。它的 ✕
  即关闭该标签，也就回到了编辑器。
- 想临时把被接管的文件交回文本编辑器，用 codelet 自带的
  **View: Reopen Editor With…**。

## 限制

- **文本类可编辑，其余不可。** 渲染结构化格式的 viewer（HTML、表格、文档、图片、
  压缩包）没有编辑器；超过阈值的文件则根本不会被读取。
- **阈值可配置，默认 64 MiB。** 更大的文件会被列出但不会读取，右栏会直接说明而不是
  加载它。该上限在后端强制，同时在元信息里提前告知，直接调用命令也无法绕过。
- **深色主题。** viewer 内容刻意保持浅色「纸张」观感——文档在两种主题下都应该
  像文档。周边框架则跟随主题。

## 新增一种格式

1. 在 `src/lib/preview/viewers/` 下新增渲染器，并在 `viewers/registry.ts` 里登记
   （扩展名 → 渲染器）。
2. 把扩展名加入 `src-tauri/file-preview-core/src/mime.rs` 的 `PREVIEWABLE`，让元信息里的
   `previewable` 标记与 MIME 推断保持一致。
3. 若需要新依赖，加进 `package.json`，并让渲染器保持动态 `import()`，以免进入首屏包。

`src/lib/preview/viewers` 与 `src/lib/preview/lib` 下搬运的文件保持上游排版，已在
`.prettierignore` 中列出；同一目录下属于宿主自己的文件（`preview.css`、`types.ts`）
照常格式化。