# Upstream Projects and Porting Record

WingHarness grew out of
[MaBangProjectsWorkflows](https://github.com/Anfioo/MaBangProjectsWorkflows), the
author's private workflow application, and now carries that application's
features in its own tree. MaBang itself carries code from a set of open-source
projects, so each ported feature has an upstream *chain*: upstream project →
MaBangProjectsWorkflows → WingHarness.

This file is the single record of that chain. It exists for two reasons:

1. **Licence hygiene.** WingHarness is GPL-3.0-only. A port is only allowed from
   a licence that is compatible with it, and the notice must travel with the
   code.
2. **Porting record.** It says which upstreams are already here, and which ones
   must never be taken.

[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lists what is actually
distributed in this repository. This file additionally records the projects that
were only read.

## Status

| Status | Meaning |
|--------|---------|
| **Ported** | Code or data from the project is in this repository. |
| **Reference** | Read for behaviour or design; no code in either repository. |

## Licence gate

Only these licences may be ported into WingHarness:

| Upstream licence | Port allowed? | Why |
|------------------|---------------|-----|
| GPL-3.0-only / GPL-3.0-or-later | Yes | Same licence as this project. |
| MIT, BSD-2/3-Clause, ISC, MIT-0 | Yes | Permissive; compatible with GPL-3.0. |
| Apache-2.0 | Yes | One-way compatible with GPL-3.0. |
| MPL-2.0, LGPL-2.1/3.0 | Yes, as a library or file-level component | Weaker copyleft; compatible with GPL-3.0. |
| Unlicense / public domain | Yes | No conditions; a copy may carry no notice, but this project records it anyway. |
| EPL-2.0 | **No** | Only compatible through EPL-2.0's Secondary License notice; without it in the source (elkjs and `@viz-js/viz` do not carry it) the code cannot be combined with GPL-3.0. |
| AGPL-3.0 | **No** | Would require the whole project to become AGPL-3.0. |
| No licence file | **No** | Default copyright: all rights reserved. Ask the author first. |
| "All rights reserved", non-commercial, or custom terms | **No** | Incompatible. |

When in doubt, do not port. Ask the upstream author for permission in writing and
record the grant in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Inventory

### Ported into this repository

The evidence column records what was found when the port was verified: a SHA-256
comparison of the ported files against each checkout, plus a source-wide search
for the project name (2026-11-05).

| Upstream | Licence | Module | Evidence |
|----------|---------|--------|----------|
| [tweakcn](https://github.com/jnsahaj/tweakcn) | Apache-2.0 | `src/lib/theme/presets.json` | Generated data snapshot; `licenses/tweakcn-LICENSE.txt` |
| [MangoDisk](https://github.com/harry0703/MangoDisk) | GPL-3.0-only | `systools-core`, `systools` page | 10 byte-identical files at import; `systools-core/UPSTREAM.md` |
| [TizuMark](https://github.com/tizuio/TizuMark-Markdown-Editor) | GPL-3.0-only | `md-editor-core`, `md-editor` page | Rewritten, no identical files; `md-editor-core/UPSTREAM.md` |
| [angkorgit](https://github.com/cheat2001/angkorgit) | MIT | `git-core`, `git-repo` page | 16 byte-identical files at import, 7 still identical; `git-core/UPSTREAM.md` |
| [OrcaSVN](https://github.com/wustites/OrcaSVN) | MIT | `svn-core`, `svn-workspace` page | Ported wholesale; `svn-core/UPSTREAM.md` |
| [shaic](https://github.com/dariocurr/shaic) | MIT | `shaic-core`, `ai-config` page | 51 byte-identical files at import, 50 still identical; `shaic-core/UPSTREAM.md` |
| [McpHub](https://github.com/Soflutionltd/McpHub) | MIT | `src-tauri/src/mcphub`, `mcp-hub` page | Every source file keeps an attribution header |
| [XTerm](https://github.com/Rockytkg/XTerm) | MIT | `server-core`, `servers` page | Rewritten, no identical files; `server-core/UPSTREAM.md` |
| [Frpilot](https://github.com/leapfu/frpilot) | MIT | `frp-core`, `frp` page | Rewritten, no identical files; `frp-core/UPSTREAM.md` |
| [Porter](https://github.com/t21dev/porter-app) | MIT | `ports-core`, `ports` page | Rewritten, no identical files; `ports-core/UPSTREAM.md` |
| [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) | MIT | `claude-chat` page, `claude_history.rs` | Behaviour port; 1 identical generic helper (`cn.ts`) |
| [use-claude](https://github.com/ekaone/use-claude) | MIT | `src/lib/use-claude` | "Vendored from `@ekaone/use-claude` (MIT)" in headers |
| [cc-switch](https://github.com/farion1231/cc-switch) | MIT | `ccs`, `cc-switch` page | Icon assets copied from `src/icons/extracted`; reads its SQLite DB |
| [openidea](https://github.com/l0ng-ai/openidea) | Apache-2.0 | `db-core`, database pages (`src/pages/database`): SQL editor, result grid, object tree, workspace tabs, query plans | Reworked for this app's conventions, no identical files; `db-core/UPSTREAM.md` and `src/pages/database/UPSTREAM.md` |
| [SpacePreview](https://github.com/likehao19/SpacePreview) | MIT | `space-preview-core`, `src/lib/space-preview`, `src/components/space-preview`, `preview-window` | Version 0.10.22 (`db531eb`); engines and viewers carried over nearly verbatim, the host and the window are a rewrite; `space-preview-core/UPSTREAM.md` and `src/components/space-preview/UPSTREAM.md` |

| [moin](https://github.com/exxvius/moin) | MIT | `moin-core`, `moin` page, `extension/` | 0.4.0 at `79e7587`; reworked for this app; `moin-core/UPSTREAM.md` |
| [ScoopInstaller/Install](https://github.com/ScoopInstaller/Install) | Unlicense | `src-tauri/resources/scoop/install.ps1` | Bundled unchanged on 2026-11-13; SHA-256 `94f983b1…f2512`; `THIRD_PARTY_NOTICES.md` |

**Notes on this group**

- **MangoDisk** and **TizuMark** are GPL-3.0-only. They are why WingHarness is
  GPL-3.0-only rather than MIT.
- **cc-switch** is mostly integrated rather than copied: the app reads
  `~/.cc-switch/cc-switch.db`. The only byte-identical file is its `hermes.png`
  icon, so the notice still has to travel.
- Every whole crate or subsystem carried over keeps a per-directory
  `UPSTREAM.md`: `git-core`, `svn-core`, `systools-core`, `md-editor-core`,
  `frp-core`, `server-core`, `ports-core`, `shaic-core`, `db-core`,
  `space-preview-core` and `moin-core`. The preview's two halves each have one —
  the Rust crate and the frontend viewers. The license text of each upstream is in `licenses/`;
  GPL upstreams point at the project's own `LICENSE`.

### Reference only — no code copied

| Upstream | Licence | What it was read for |
|----------|---------|----------------------|
| [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) | GPL-3.0-only | Clash page design; `prism-core` itself is first-party, built on the `clash-prism-extension` crate |
| [Rust-Frp](https://github.com/Nu0vo1212/Rust-Frp) | Apache-2.0 | FRP protocol and process behaviour |
| [Zephyr](https://github.com/Juwan-Hwang/Zephyr) | MIT | Mihomo GUI design |

## Porting checklist

Use this for every feature carried over.

1. **Identify the upstream.** Walk the chain to the original project, not just
   MaBang. Check the licence of the *original*, not an intermediate copy.
2. **Check the gate.** The licence must be in the allowed list above. If the
   upstream has no licence, stop and ask.
3. **Record the version.** Note the upstream version and commit in the porting
   entry (or in a per-directory `UPSTREAM.md` — see below).
4. **Keep the attribution header.** Every ported file starts with a short
   comment naming the upstream project and licence.
5. **Write a per-directory `UPSTREAM.md`** when a whole crate or subsystem is
   carried over. It records origin, version, what was changed, and how to take
   an upstream change later. `src-tauri/shaic-core/UPSTREAM.md` is the model.
6. **Update the notices.** Add the project to
   [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and flip its status here.
7. **Document it.** Add or update the guide under `docs/features/`, in both languages
   (`FEATURE.md` and `FEATURE.zh-CN.md`), and link it from both READMEs.
8. **Check the build.** `pnpm check` plus the feature's own smoke test.

## Change log

| Date | Change |
|------|--------|
| 2026-11-05 | File created; inventory compiled from both repositories and their `.dev` checkouts. |
| 2026-11-05 | Inventory re-verified by hashing every file under MaBang's `src/`, `src-tauri/` and `scripts/` against each checkout and searching the source for each project name. |
| 2026-11-05 | WingHarness absorbed the MaBangProjectsWorkflows tree; every pending module is now ported and its status flipped to **Ported**. |
| 2026-11-05 | Licence audit: upstream license texts added under `licenses/`, attribution headers and `UPSTREAM.md` records added to every ported crate, tweakcn corrected from MIT to Apache-2.0, and the evidence column updated to the current tree. |
| 2026-11-06 | openidea moved from **Reference** to **Ported**: its `crates/ide-db` became `src-tauri/db-core`, with `db-core/UPSTREAM.md` recording the divergences. |
| 2026-11-06 | Databases P2: `ide-db`'s introspection (catalog queries from `sql.rs`, DTOs from `lib.rs`) added as `db-core/src/{sql,objects}.rs`, with `db_databases`, `db_schemas`, `db_tables`, `db_table_details` and `db_schema_objects`. |
| 2026-11-07 | Databases P3: multi-statement execution, table paging and row editing, DDL generation, completion, the tabbed window and the CodeMirror console carried over from `ide-db` and openidea's frontend; `src/pages/database/UPSTREAM.md` added, `db-core/UPSTREAM.md` updated. |
| 2026-11-07 | Databases P4 (workspace): query files, persisted window tabs and row limits as a first-party `db-core` workspace, plus execution plans from `ide-db`'s `plan.rs`; the tree groups, grid interactions and tab strip follow openidea's behaviour. `db-core/UPSTREAM.md` and `src/pages/database/UPSTREAM.md` updated. |
| 2026-11-09 | Ports: `src-tauri/ports-core` and the ports page ported from Porter (MIT); `ports-core/UPSTREAM.md` and the guide pair `docs/features/PORTS.md` / `.zh-CN.md` added. |
| 2026-11-10 | SpacePreview recorded as **Ported**: its Rust side became `space-preview-core` and its engines/viewers became `src/lib/space-preview` and `src/components/space-preview`, behind the upgraded File Preview page, the standalone preview window and the editors' preview tabs. The CAD/3D/RAW/design-thumbnail and Graphviz (EPL-2.0) branches were not carried over. |
| 2026-11-10 | Licence audit follow-up: mermaid pulled `elkjs` (EPL-2.0) into the bundle; `vite.config.ts` now aliases it to `src/lib/elk-stub.ts` so the code is not redistributed. `buffers` (no licence) was confirmed not to reach the Excel viewer bundle because Vite resolves ExcelJS's browser build. |
| 2026-11-11 | moin 0.4.0 (`79e7587`, MIT) ported as `src-tauri/moin-core`, the download page and `extension/`; `moin-core/UPSTREAM.md` and `licenses/moin-LICENSE.txt` added, notices updated. The general daemon was replaced by embedded commands/events; the extension RPC and aria2 backend were retained. |

