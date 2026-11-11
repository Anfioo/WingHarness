# Third-Party Notices

WingHarness — Copyright (C) 2026 Anfioo

WingHarness is distributed under the GNU General Public License, version 3 only
(GPL-3.0-only); see [LICENSE](./LICENSE). This file records the third-party work
redistributed with it and the terms each part keeps. It does not alter the
license of the project's own code.

The English text of this file is authoritative; a Chinese translation is in
[THIRD_PARTY_NOTICES.zh-CN.md](./THIRD_PARTY_NOTICES.zh-CN.md). The inventory of
every upstream project that has been read, ported or only referenced —
including the ones whose code is **not** in this repository — is
[docs/UPSTREAM_PROJECTS.md](./docs/UPSTREAM_PROJECTS.md).

---

## 1. Source projects

### angkorgit

- Project: [angkorgit](https://github.com/cheat2001/angkorgit)
- License: MIT
- License text: [licenses/AngKorGit-LICENSE.txt](./licenses/AngKorGit-LICENSE.txt)

`src-tauri/git-core` — the engine behind the Git repository window — is adapted
from angkorgit. Sixteen files were byte-identical at import; the crate is now
maintained here as first-party code.

### cc-switch

- Project: [cc-switch](https://github.com/farion1231/cc-switch)
- License: MIT
- License text: [licenses/cc-switch-LICENSE.txt](./licenses/cc-switch-LICENSE.txt)

`src-tauri/src/ccs` and the CC Switch page implement the same provider model and
read cc-switch's SQLite database (`~/.cc-switch/cc-switch.db`). The `hermes.png`
icon is copied from the upstream project.

### Frpilot

- Project: [Frpilot](https://github.com/leapfu/frpilot)
- Version: 1.0.0
- License: MIT
- License text: [licenses/Frpilot-LICENSE.txt](./licenses/Frpilot-LICENSE.txt)

Copyright (c) leapfu. Portions of the frpc process manager, TOML generator,
runtime discovery and log handling are adapted from Frpilot. SQLite persistence,
keyring credential storage and the official runtime downloader from the upstream
project were not ported.

### jetbrains-cc-gui

- Project: [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)
- License: MIT
- License text: [licenses/jetbrains-cc-gui-LICENSE.txt](./licenses/jetbrains-cc-gui-LICENSE.txt)

The Claude chat page and `src-tauri/src/commands/claude_history.rs` are a
behaviour port of jetbrains-cc-gui; one generic helper (`cn.ts`) was copied.

### MangoDisk

- Project: [MangoDisk](https://github.com/harry0703/MangoDisk)
- Version: 1.2.2
- License: GPL-3.0-only
- License text: [LICENSE](./LICENSE)
- Copyright: the MangoDisk contributors.

The system tools module (`src-tauri/systools-core` and the systools pages) is
derived from MangoDisk: disk analysis, duplicate files, large files, startup
items, application uninstall / leftovers, and system settings. Ten files were
byte-identical at import. Those portions are redistributed under GPL-3.0-only;
the full license text is in [LICENSE](./LICENSE). The ported subsystem is
Windows-only; macOS and Linux code paths were not carried over.

### McpHub

- Project: [McpHub](https://github.com/Soflutionltd/McpHub)
- License: MIT
- License text: [licenses/McpHub-LICENSE.txt](./licenses/McpHub-LICENSE.txt)

`src-tauri/src/mcphub` is adapted from McpHub; every source file keeps its
attribution header.

### moin

- Project: [moin](https://github.com/exxvius/moin)
- Version: 0.4.0
- License: MIT
- License text: [licenses/moin-LICENSE.txt](./licenses/moin-LICENSE.txt)

moin (https://github.com/exxvius/moin)
Copyright (c) 2026 moin contributors
Licensed under the MIT License.
The download engine, segmented `Range` transfer, task store, aria2 backend,
category rules, download/category/settings UI and browser capture extension are
adapted from moin.

`src-tauri/moin-core` is the engine behind the download page. It is reworked for
this app: upstream runs its engine in a separate `moin-daemon` process reached
over loopback HTTP, while this port embeds the engine inside the Tauri process
and drives it through commands and events. The extension-only `/ping` and `/add`
loopback RPC remains in `rpc.rs`; `extension/` carries the adapted MV3 source.
BitTorrent, media scraping, self-update, old-data migration and in-app aria2c
installation were not carried over. See `src-tauri/moin-core/UPSTREAM.md` for
the porting record.

### openidea

- Project: [openidea](https://github.com/l0ng-ai/openidea)
- Version: 0.1.37
- License: Apache-2.0
- License text: [licenses/Apache-2.0.txt](./licenses/Apache-2.0.txt)

Portions of the database feature — the SQL lexer, dialect, analysis, completion,
formatting, DDL generation, the result grid with its search bar and side panel,
the object tree's groups and context menus, the workspace tab strip and query
plans — are adapted from openidea. Copyright (c) the openidea authors, licensed
under the Apache License, Version 2.0.

`src-tauri/db-core` and the database pages are ported from openidea's
`crates/ide-db`: data sources, connections, introspection, multi-statement query
execution, table paging and row editing, DDL generation, completion and query
plans. The SSH tunnelling, SQL Server, ClickHouse and Oracle paths, the `specta`
type generation, the keychain password store and the chart view were not carried
over. See `src-tauri/db-core/UPSTREAM.md` and
`src/pages/database/UPSTREAM.md` for the porting record.

### OrcaSVN

- Project: [OrcaSVN](https://github.com/wustites/OrcaSVN)
- License: MIT
- License text: [licenses/OrcaSVN-LICENSE.txt](./licenses/OrcaSVN-LICENSE.txt)

`src-tauri/svn-core` and the SVN workspace pages are ported wholesale from
OrcaSVN, as stated in `svn-core/src/lib.rs`.

### Porter

- Project: [Porter](https://github.com/t21dev/porter-app)
- Version: v0.7.1
- License: MIT
- License text: [licenses/Porter-LICENSE.txt](./licenses/Porter-LICENSE.txt)

Porter (https://github.com/t21dev/porter-app)
Copyright (c) 2025 Porter App Contributors
Licensed under the MIT License.
Portions of the Windows TCP listener enumeration, port scan, process lookup,
process termination and the port list/detail/settings UI are adapted from
Porter.

`src-tauri/ports-core` is the engine behind the ports page. It is rewritten, not
copied: only the Windows TCP listener table, the scan's three states, the
process lookup and termination path, the one-shot elevation behaviour and the
DTOs are derived from Porter. The macOS, Linux and Flatpak paths, outbound
connections, UDP, whole-app elevation and the shell/theme/update features were
not carried over. See `src-tauri/ports-core/UPSTREAM.md` for the porting record.

### shaic

- Project: [shaic](https://github.com/dariocurr/shaic)
- Version: v0.3.0
- License: MIT
- License text: [licenses/shaic-LICENSE.txt](./licenses/shaic-LICENSE.txt)

`src-tauri/shaic-core` derives from the `core/` crate of shaic; fifty-one files
were byte-identical at import. The crate is now a first-party engine and is
edited here. See `src-tauri/shaic-core/UPSTREAM.md` for the porting record.

### SpacePreview

- Project: [SpacePreview](https://github.com/likehao19/SpacePreview)
- Version: 0.10.22
- License: MIT
- License text: [licenses/SpacePreview-LICENSE.txt](./licenses/SpacePreview-LICENSE.txt)

SpacePreview / Copyright (c) 2026 likehao19 / Licensed under the MIT License.
Portions of the preview engines, viewers and Windows Space integration are
adapted from SpacePreview. `src-tauri/space-preview-core` is the Rust side
(file inspection and ranged reads, text write-back with encodings, HTML
resources, PowerPoint conversion, system icons and the Windows space agent);
`src/lib/space-preview` and `src/components/space-preview` are the ported format
engines, Web Worker, viewers and scoped stylesheet, behind the upgraded File
Preview page, the standalone preview window and the editors' preview tabs. The
CAD, 3D-model, RAW-image, design-thumbnail and Graphviz (EPL-2.0) branches were
not carried over. See `src-tauri/space-preview-core/UPSTREAM.md` and
`src/components/space-preview/UPSTREAM.md`.

### TizuMark

- Project: [TizuMark](https://github.com/tizuio/TizuMark-Markdown-Editor)
- License: GPL-3.0-only
- License text: [LICENSE](./LICENSE)
- Copyright: the TizuMark contributors.

The Markdown editor module (`src-tauri/md-editor-core` and the md-editor pages)
is a port of TizuMark. Its native PDF export (WebView2 `PrintToPdf`, built on
`webview2-com` / `windows`), outline extraction and export approach are
substantial ports and remain under GPL-3.0-only. The frontend is a rewrite for
React 19 and CodeMirror 6 rather than a copy of TizuMark's implementation.

### tweakcn

- Project: [tweakcn](https://tweakcn.com) — [jnsahaj/tweakcn](https://github.com/jnsahaj/tweakcn)
- License: Apache-2.0
- License text: [licenses/tweakcn-LICENSE.txt](./licenses/tweakcn-LICENSE.txt)

`src/lib/theme/presets.json` is a snapshot of the themes tweakcn publishes,
generated by `scripts/fetch-theme-presets.mjs` (`pnpm themes:fetch`). The file
carries colour-token data only — no upstream source code.

### use-claude

- Project: [use-claude](https://github.com/ekaone/use-claude)
- License: MIT
- License text: [licenses/use-claude-LICENSE.txt](./licenses/use-claude-LICENSE.txt)

`src/lib/use-claude` is vendored from the `@ekaone/use-claude` package; its
headers keep the attribution.

### XTerm

- Project: [XTerm](https://github.com/Rockytkg/XTerm)
- Version: 1.0.6
- License: MIT
- License text: [licenses/XTerm-LICENSE.txt](./licenses/XTerm-LICENSE.txt)

The SSH / SFTP backend of the server manager module (`src-tauri/server-core`) is
a trimmed rewrite carrying over XTerm's `russh` / `russh-sftp` usage, host-key
fingerprinting (`ring` SHA-256, unpadded base64, `SHA256:` prefix) and connection
timeouts. The Vue frontend was not copied; this application's UI is React.

---

## 2. Bundled libraries

The tables below list the direct dependencies redistributed inside the built
application. Exact versions are pinned by `pnpm-lock.yaml` and
`src-tauri/Cargo.lock`. Transitive dependencies resolve from the same two
lockfiles; the ones that are not under a permissive licence are called out after
the Rust table. Each dependency ships its own license text in `node_modules` or
its crate source.

### JavaScript / TypeScript

| Package | License |
|---------|---------|
| `7z-wasm` | LGPL + unRAR restriction — see §3 |
| `@asciidoctor/core` | MIT |
| `@codemirror/commands` | MIT |
| `@codemirror/lang-markdown` | MIT |
| `@codemirror/language` | MIT |
| `@codemirror/search` | MIT |
| `@codemirror/state` | MIT |
| `@codemirror/view` | MIT |
| `@dnd-kit/core` | MIT |
| `@dnd-kit/sortable` | MIT |
| `@dnd-kit/utilities` | MIT |
| `@kenjiuno/msgreader` | Apache-2.0 |
| `@lezer/highlight` | MIT |
| `@mind-elixir/import-xmind` | MIT |
| `@tailwindcss/vite` | MIT |
| `@tanstack/react-virtual` | MIT |
| `@tauri-apps/api` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-dialog` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-global-shortcut` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-opener` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-process` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-updater` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-window-state` | MIT OR Apache-2.0 |
| `@xterm/addon-fit` | MIT |
| `@xterm/xterm` | MIT |
| `ag-psd` | MIT |
| `buffer` | MIT |
| `cfb` | Apache-2.0 |
| `chart.js` | MIT |
| `class-variance-authority` | Apache-2.0 |
| `clsx` | MIT |
| `cmdk` | MIT |
| `cn` | MIT |
| `codelet` | MIT |
| `comlink` | Apache-2.0 |
| `docx-preview` | Apache-2.0 |
| `dompurify` | MPL-2.0 OR Apache-2.0 |
| `exceljs` | MIT |
| `fast-xml-parser` | MIT |
| `fflate` | MIT |
| `fzstd` | MIT |
| `highlight.js` | BSD-3-Clause |
| `i18next` | MIT |
| `i18next-browser-languagedetector` | MIT |
| `icojs` | MIT |
| `jszip` | MIT OR GPL-3.0-or-later |
| `katex` | MIT |
| `libarchive.js` | MIT |
| `lottie-web` | MIT |
| `lucide-react` | ISC |
| `mammoth` | BSD-2-Clause |
| `marked` | MIT |
| `mermaid` | MIT |
| `mind-elixir` | MIT |
| `node-unrar-js` | MIT |
| `opentype.js` | MIT |
| `papaparse` | MIT |
| `pdfjs-dist` | Apache-2.0 |
| `postal-mime` | MIT-0 |
| `pptxviewjs` | MIT |
| `radix-ui` | MIT |
| `react`, `react-dom` | MIT |
| `react-day-picker` | MIT |
| `react-i18next` | MIT |
| `react-resizable-panels` | MIT |
| `rtf.js` | MIT |
| `seek-bzip` | MIT |
| `sonner` | MIT |
| `sql.js` | MIT |
| `tailwind-merge` | MIT |
| `tailwindcss` | MIT |
| `utif` | MIT |
| `xlsx` | Apache-2.0 |
| `xz-decompress` | MIT |
| `yaml` | ISC |
| `zustand` | MIT |

### Rust

| Crate | License |
|-------|---------|
| `async-trait` | MIT OR Apache-2.0 |
| `base64` | MIT OR Apache-2.0 |
| `blake3` | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception |
| `bytes` | MIT |
| `chrono` | MIT OR Apache-2.0 |
| `clap` | MIT OR Apache-2.0 |
| `clash-prism-extension` | Apache-2.0 |
| `dirs` | MIT OR Apache-2.0 |
| `encoding_rs` | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| `font-kit` | MIT OR Apache-2.0 |
| `fontdb` | MIT |
| `fs2` | MIT OR Apache-2.0 |
| `futures-util` | MIT OR Apache-2.0 |
| `getrandom` | MIT OR Apache-2.0 |
| `git2` | MIT OR Apache-2.0 |
| `hex` | MIT OR Apache-2.0 |
| `indexmap` | Apache-2.0 OR MIT |
| `keyring` | MIT OR Apache-2.0 |
| `log` | MIT OR Apache-2.0 |
| `mime_guess` | MIT |
| `notify-debouncer-mini` | MIT OR Apache-2.0 |
| `once_cell` | MIT OR Apache-2.0 |
| `png` | MIT OR Apache-2.0 |
| `portable-pty` | MIT |
| `quick-xml` | MIT |
| `regex` | MIT OR Apache-2.0 |
| `reqwest` | MIT OR Apache-2.0 |
| `ring` | Apache-2.0 AND ISC |
| `rusqlite` | MIT |
| `russh` | Apache-2.0 |
| `russh-sftp` | Apache-2.0 |
| `serde`, `serde_json` | MIT OR Apache-2.0 |
| `serde_yaml_ng` | MIT |
| `serde_yml` | MIT OR Apache-2.0 |
| `sha2` | MIT OR Apache-2.0 |
| `tauri` | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | Apache-2.0 OR MIT |
| `tauri-plugin-global-shortcut` | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | Apache-2.0 OR MIT |
| `tauri-plugin-process` | Apache-2.0 OR MIT |
| `tauri-plugin-single-instance` | Apache-2.0 OR MIT |
| `tauri-plugin-updater` | Apache-2.0 OR MIT |
| `tauri-plugin-window-state` | Apache-2.0 OR MIT |
| `tempfile` | MIT OR Apache-2.0 |
| `thiserror` | MIT OR Apache-2.0 |
| `tokio` | MIT |
| `toml` | MIT OR Apache-2.0 |
| `toml_edit` | MIT OR Apache-2.0 |
| `url` | MIT OR Apache-2.0 |
| `uuid` | Apache-2.0 OR MIT |
| `walkdir` | Unlicense OR MIT |
| `webview2-com` | MIT |
| `which` | MIT |
| `windows` | MIT OR Apache-2.0 |
| `windows-core` | MIT OR Apache-2.0 |
| `windows-sys` | MIT OR Apache-2.0 |
| `winreg` | MIT |
| `zip` | MIT |

`tauri-build` is a build-time dependency and is not redistributed.

### Transitive dependencies worth calling out

The lockfiles resolve roughly 500 JavaScript and 850 Rust packages. Almost all
are MIT, Apache-2.0, BSD, ISC or a compatible combination of those. The
exceptions are:

| Package | License | Pulled in by | Note |
|---------|---------|--------------|------|
| `elkjs` | EPL-2.0 | `mermaid` | **Not redistributed.** `vite.config.ts` aliases the package to `src/lib/elk-stub.ts` because EPL-2.0 is not on the porting gate's allowed list. A diagram that explicitly asks for an ELK layout reports that the layout is unavailable; every other mermaid layout uses dagre. |
| `lightningcss`, `lightningcss-win32-x64-msvc` | MPL-2.0 | `@tailwindcss/vite`, `vite` | Build-time only; not redistributed in the application. |
| `buffers` | none stated | `exceljs` → `unzipper` → `binary` | **Not redistributed.** Vite resolves ExcelJS's `browser` entry (`dist/exceljs.min.js`), which uses JSZip and contains no `unzipper`, `binary` or `buffers` code. |

MPL-2.0 is a file-level copyleft and is compatible with GPL-3.0-only; the
MPL-2.0 components above are build tooling and are not redistributed. The
Apache-2.0 text is reproduced in
[licenses/Apache-2.0.txt](./licenses/Apache-2.0.txt).

The MIT, BSD, ISC, Apache-2.0, MPL-2.0 and LGPL components are compatible with
GPL-3.0-only: the combined work is distributed under GPL-3.0-only, while each
library keeps its own terms. `7z-wasm` is covered separately by the notice in
§3, which must accompany distribution.

---

## 3. 7-Zip notice

`7z-wasm` (`https://github.com/use-strict/7z-wasm`) embeds 7-Zip. Its license
requires this notice to accompany distribution:

> 7-Zip Copyright (C) 1999-2015 Igor Pavlov.
>
> Licenses for files are:
>
> 1. `7zz.*.js`, `7zz.wasm`: GNU LGPL + unRAR restriction
> 2. All other files: GNU LGPL
>
> The GNU LGPL + unRAR restriction means that you must follow both GNU LGPL
> rules and unRAR restriction rules.

The unRAR restriction states that the source may be used to handle RAR archives
without limitation, but **may not be used to develop a RAR-compatible
archiver**; neither the RAR archiver nor unRAR may be used to re-create the RAR
compression algorithm.

The 7-Zip notice and the unRAR restriction are reproduced in:

- [licenses/7z-wasm-License.txt](./licenses/7z-wasm-License.txt)
- [licenses/7z-wasm-unRarLicense.txt](./licenses/7z-wasm-unRarLicense.txt)

The GNU Lesser General Public License it refers to is reproduced in
[licenses/LGPL-2.1.txt](./licenses/LGPL-2.1.txt).

`node-unrar-js` is MIT-licensed and carries no separate unRAR restriction.

---

## 4. Reporting an omission

If you believe a work has been redistributed without the notice it requires,
open an issue at https://github.com/Anfioo/WingHarness/issues — see
[CONTRIBUTING.md](./CONTRIBUTING.md).
