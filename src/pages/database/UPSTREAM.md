# Origin: src/pages/database

Derived from the `src/features/database` folder of
[l0ng-ai/openidea](https://github.com/l0ng-ai/openidea), the database tools of
that IDE: the SQL console, the table editor, the result grid and the objects
tree.

- Upstream version at import: **0.1.37** (workspace `version = "0.1.37"`)
- Upstream commit: **9069c322** (2026-11-06), see the `.dev/openidea` checkout
- License: Apache-2.0 — one-way compatible with this project's GPL-3.0-only.
  The full text is in [`licenses/Apache-2.0.txt`](../../../licenses/Apache-2.0.txt).
- Imported subtree: `src/features/database/`

## Status

The pages are maintained here as first-party code. They were **not** copied
byte-for-byte: upstream uses CSS Modules, its own `@/ui` component set and an
`@/platform/ipc` bridge, while this app uses Tailwind CSS v4, shadcn/ui and
`@/commands`. Copying upstream over this directory would drop that work and
break every import. Take changes by hand.

## File map

The table lists what this directory is expected to hold once phase 2 is done.
Rows marked *new* have no upstream counterpart: this app owns the window shell,
which upstream does not have.

| Local file | Upstream file | Treatment |
|------------|---------------|-----------|
| `window.tsx`, `window-tabs.tsx`, `tab-bar.tsx` | — | New: the window frame, its tab model and its tab strip |
| `console-view.tsx` | `console.tsx`, `sqlSupport.ts` | Reference rewrite: CodeMirror 6 with `@codemirror/autocomplete` and `@codemirror/lint` instead of upstream's SQL support layer |
| `table-editor.tsx` | `TableEditor.tsx`, `model.ts` (edit part) | Reference rewrite |
| `result-grid.tsx` | `Grid.tsx` | Reference rewrite on Tailwind, shadcn/ui and `@tanstack/react-virtual` |
| `result-view.tsx` | `ResultsView.tsx`, `DataView.tsx` | Reference rewrite: output and per-statement result tabs, toolbar, paging, export |
| `object-tree.tsx` | `DatabaseView.tsx`, `nodes.ts`, `treeMenu.ts` | Phase 1 already rewrote it; keep the local version |
| `tree-model.ts` | `nodes.ts` | Phase 1 already rewrote it; keep the local version |
| `source-dialog.tsx` | `SourceDialog.tsx` | Not carried over: the local flat form stays, phase 2 only adds the vendor presets |
| `vendors.ts` | `vendors.ts` | Trimmed port: only the presets the SQLite, PostgreSQL and MySQL drivers can actually connect to |
| `sql/` (lexer, dialect, analyze, complete, resolve, format, params, readOnly) | `sql/*.ts` | Direct port, with an attribution header; `@/platform/ipc` becomes `@/commands` |
| `object-sql.ts` | `objects.ts` | Direct port (pure functions) |
| `export.ts` | `export.ts` | Direct port; the file write goes through `save_text_file` |
| `cell-preview.ts` | `cellPreview.ts` | Direct port |
| `result-view-model.ts` | `resultView.ts`, `model.ts` | Partial port: sort, filter, paging and aggregates; the chart series is dropped |

Deliberately not carried over: `store.ts` (this app keeps no global database
store), `ChartView.tsx`, `DataDialogs.tsx` (the import half; history lives in
the console), `Dialogs.tsx`, `Database.module.css`, and everything behind
`plan.ts`, ClickHouse and Oracle.

## Taking an upstream change

1. Diff the local file against `src/features/database/` in the `.dev/openidea`
   checkout.
2. Apply it by hand on top of the local rewrite, keeping Tailwind + shadcn/ui,
   the `@/commands` wrappers, English-only code strings and the i18n keys under
   `database.*`.
3. `pnpm build` and smoke-test the databases page and a data source window.
