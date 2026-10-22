# 文件预览

**文件预览**页是一个只读的查看器，用来打开所配置项目根目录里的文件。
它位于侧边栏「笔记」之后，复用**项目**页所服务的同一个根目录——路径来自
「设置 → 项目」，由后端解析并限制在该目录之内。

它基于 [Office-Viewer 参考实现](../.dev/Office-Viewer) 的 viewer 子系统，
搬进本仓库时去掉了重且少用的几条链路（HEIC、`.class` 反编译、Parquet、PNG 导出）。

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
  [`src-tauri/file-preview`](../src-tauri/file-preview)，只暴露两个命令。
- **文件树按需加载。** `project_tree` 一次只返回一层目录，因此一个装着 `.git`、
  `node_modules` 与构建产物的项目，成本只等于屏幕上真实显示的部分。
  永不对外提供。
- **渲染器天然分包。** 每种格式都是 `await import('./xxxRenderer')`，从未预览过
  表格的窗口也就不会加载 exceljs。
- **UI 用宿主自己的。** 页面、文件树与工具栏都是 shadcn/ui + Tailwind；viewer
  自己的 CSS 限定在 `.ov-preview` 之下，因此它对裸 `button` 的样式不会影响到
  应用其它部分。

## 命令

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `preview_metadata` | `path` | `PreviewMeta` | `/` 开头的相对路径；含大小、mime、`previewable`、`overCap` |
| `preview_bytes` | `path` | Raw IPC 字节 | 超出 64 MiB 上限、或不在项目根目录之内时拒绝 |

`path` 始终是根相对、`/` 开头的形式，与文件树使用的写法一致。两个命令都通过应用
启动时注入的 provider 解析根路径，因此「设置 → 项目」里的改动会在下一次读取时生效。

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

## 在编辑器里

同一套 viewer 也注册成了 codelet 扩展
（[`src/lib/editor/preview-extension.ts`](../src/lib/editor/preview-extension.ts)），
**笔记**与**项目**两页都会挂载：文本编辑器读不了的文件——`.docx`、`.png`——
于是以预览打开，而不是只拿到 transport 写下的占位符。

- 只接管文本编辑器做得更差的那部分格式。列在 `TEXT_EXTENSIONS` 里的扩展名
  （Markdown、JSON、TOML、常见源码扩展名、`csv`、`tsv`、`svg`、HTML）仍归文本
  编辑器；registry 里其余格式由一条生成出来的 `**/*.{…}` 选择器全数接管，因此往
  `registry.ts` 里新增渲染器时这里也自动生效。
- 面板自身不画任何东西：扩展只把打开的路径转给宿主，由宿主的
  [`PreviewOverlay`](../src/components/file-preview/preview-overlay.tsx) 盖住工作台，
  并按本页一模一样的顺序加载——同一个 `PreviewPane`、同一套 viewer。它的 ✕
  即关闭该标签，也就回到了编辑器。
- 想临时把被接管的文件交回文本编辑器，用 codelet 自带的
  **View: Reopen Editor With…**。

## 限制

- **只读。** 本页不会写回磁盘；要编辑请用**项目**页。
- **64 MiB 上限。** 更大的文件会被列出但不会读取，右栏会直接说明而不是加载它。
  该上限在后端强制，同时在元信息里提前告知，直接调用命令也无法绕过。
- **深色主题。** viewer 内容刻意保持浅色「纸张」观感——文档在两种主题下都应该
  像文档。周边框架则跟随主题。

## 新增一种格式

1. 在 `src/lib/preview/viewers/` 下新增渲染器，并在 `viewers/registry.ts` 里登记
   （扩展名 → 渲染器）。
2. 把扩展名加入 `src-tauri/file-preview/src/mime.rs` 的 `PREVIEWABLE`，让元信息里的
   `previewable` 标记与 MIME 推断保持一致。
3. 若需要新依赖，加进 `package.json`，并让渲染器保持动态 `import()`，以免进入首屏包。

`src/lib/preview/viewers` 与 `src/lib/preview/lib` 下搬运的文件保持上游排版，已在
`.prettierignore` 中列出；同一目录下属于宿主自己的文件（`preview.css`、`types.ts`）
照常格式化。