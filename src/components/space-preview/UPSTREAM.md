# Origin: the preview viewers

The webview side of the file preview — the format engines, the Web Worker, the
viewers and the stylesheet — is adapted from
[SpacePreview](https://github.com/likehao19/SpacePreview), a standalone desktop
previewer.

- Upstream version at import: **0.10.22**
- Upstream commit: **db531eb** (2026-11-09), see the `.dev/Projects/SpacePreview`
  checkout
- License: MIT — see
  [licenses/SpacePreview-LICENSE.txt](../../licenses/SpacePreview-LICENSE.txt).
  MIT is one-way compatible with this project's GPL-3.0-only.
- Imported subtree: `src/lib/*.ts`, `src/lib/worker/`, `src/components/*.tsx`,
  `src/styles.css`

The upstream application (`App.tsx`, the updater, autostart, the macOS and
QuickLook code) was not carried over: WingHarness is a multi-window workspace,
so the preview shell is its own rewrite. The engine and the shell meet at
`src/lib/space-preview/bridge.ts` and the `sp_*` commands, which is what keeps
the port boundary clean.

## What is kept

| Local path | Upstream files | Notes |
|------------|----------------|-------|
| `src/lib/space-preview/engine/` | `src/lib/{archive,office,docx,ofd,mail,html,tiff,psd,xmind,extra-formats,…}.ts`, `src/lib/files.ts` | The parsing code, in its upstream style. `files.ts` became the type/size helpers; the extension table moved to `registry.ts`. |
| `src/lib/space-preview/worker/` | `src/worker/{preview.worker,worker-client,worker-types}.ts` | comlink RPC and the off-main-thread parsers |
| `src/components/space-preview/viewers/` | `src/components/{Preview,WordPreview,OfficePreview,ArchivePreview,DocumentReader,FontPreview,HtmlPreview,MailPreview,PdfPage,OfdPage,DiagramPreview,AnimationPreview,DatabasePreview,WebArchivePreview,…}.tsx` | Kept in upstream style; the labels they render now come from i18n instead of Chinese literals |
| `src/components/space-preview/space-preview.css` | `src/styles.css` | The upstream stylesheet, scoped under `.sp-preview` |

Every ported file starts with the attribution comment
`// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.`
Files under the four ported directories and `space-preview.css` are listed in
`.prettierignore` so a reformat does not bury the real edits.

## What changes

| Local path | Notes |
|------------|-------|
| `src/lib/space-preview/registry.ts` | The extension → engine table, trimmed to the core set; labels are English keys the UI translates. `detectKind`, `inspectKind`, `previewMime`, `isPreviewExtension` wrap it. |
| `src/lib/space-preview/bridge.ts` | Rewritten data bridge: `sp_*` commands instead of the asset protocol, and blob URLs for images, media, fonts and HTML resources. |
| `src/lib/space-preview/preferences.ts` | Wraps the preferences commands and repairs values a damaged `preview.json` left behind. |
| `src/components/space-preview/host.tsx` | New host: embedded vs window mode, the toolbar, edit mode, encoding selection and the error/empty states. Upstream had no such seam. |
| `src/components/space-preview/window/` | New window chrome (frame and multi-selection bar), replacing upstream's `App.tsx`. |
| `src/lib/space-preview/window-session.ts` | New selection session for the standalone window. |
| `src/components/space-preview/space-preview.css` | Global selectors were rewritten below `.sp-preview`; the bare `button` and `:root` rules would otherwise leak into the application shell. |

## What is dropped

- CAD (`.dxf`, `.dwg`, …), 3D models, RAW/professional image formats and design
  thumbnails — they need `three`, `occt-import-js`, `assimpjs`,
  `@imagemagick/magick-wasm` or similar, which this project does not ship.
- Graphviz (`.dot`, `.gv`): `@viz-js/viz` is EPL-2.0, which is not on the
  licence gate's allowed list. The `diagram` engine keeps mermaid only, and
  mermaid's own ELK layout is excluded for the same reason (elkjs is EPL-2.0).
- The directory preview, the directory sidebar, the file search pane, the tab
  strip and reading-position memory — the standalone window deliberately has
  only multi-selection and the arrow keys.
- The upstream updater, autostart, macOS (`macos_*`), the QuickLook named pipe
  and its inspector/log pages.

## Later upstream changes

The port is now first-party code edited here. A later upstream change has to be
re-read against these tables rather than merged: the engine files are close to
verbatim, the registry, bridge, host and window are not.
