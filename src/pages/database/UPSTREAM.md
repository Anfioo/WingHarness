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

Line counts are from the workspace baseline (2026-11-07); they move, but they
show where the weight sits. Every *ported* file starts with
`Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.`; the other
files are first-party rewrites or this app's own additions.

| Local file (lines) | Upstream file | Treatment |
|--------------------|---------------|-----------|
| `index.tsx` (428) | `DatabasePage.tsx` | Rewritten on shadcn/ui: the picker, its list, add / edit / duplicate / delete and test |
| `window.tsx` (71) | — | New: the window frame and the connection guard |
| `tab-bar.tsx` (51) | — | New: the tab strip |
| `console-view.tsx` (624) | `console.tsx`, `sqlSupport.ts` | Reference rewrite: output and per-statement result tabs, run / run all / cancel, manual commit, history |
| `console-editor.tsx` (399) | `console.tsx` | Reference rewrite: CodeMirror 6 with `@codemirror/autocomplete`, `@codemirror/lang-sql` and `@codemirror/lint` |
| `table-editor.tsx` (392) | `TableEditor.tsx` | Reference rewrite on the shared grid: paging, draft, submit, read-only state |
| `table-editor-model.ts` (158) | `model.ts` (edit half) | Partial port: the draft model (changed cells, added and deleted rows) |
| `result-grid.tsx` (700) | `Grid.tsx` | Reference rewrite on Tailwind, shadcn/ui and `@tanstack/react-virtual`; column resize, selection copy |
| `result-view.tsx` (327) | `ResultsView.tsx`, `DataView.tsx` | Reference rewrite: statement tabs, toolbar, paging, export |
| `result-view.ts` (244) | `resultView.ts`, `model.ts` | Partial port (pure): sort, filter, paging and aggregates; the chart series is dropped |
| `object-tree.tsx` (781) | `DatabaseView.tsx`, `nodes.ts`, `treeMenu.ts` | Phase 1 rewrite, extended in phase 2 with the double-click split and the context menu |
| `tree-model.ts` (98) | `nodes.ts` | Phase 1 rewrite |
| `tree-menu.ts` (171) | `treeMenu.ts` | Ported: menu items and their disabled reasons, as data rather than JSX |
| `object-dialogs.tsx` (816) | `Dialogs.tsx` (object half) | Ported, then rewritten on shadcn/ui: rename, drop, truncate, new table, modify table |
| `object-sql.ts` (346) | `objects.ts` | Ported: pure SQL builders |
| `sql-preview.tsx` (123) | `Dialogs.tsx` (preview half) | Ported: a rendering of the statement string with run / send-to-console |
| `columns-popup.tsx` (116) | — | New: "go to column" (`Ctrl+F12`) |
| `filter-input.tsx` (198) | — | New: `WHERE` filter box with completion, reusing `sql/` |
| `export.ts` (136) | `export.ts` | Ported: CSV, TSV, JSON, SQL and Markdown; the file write goes through `save_text_file` |
| `cell-preview.ts` (12) | `cellPreview.ts` | Ported: the cell text preview |
| `vendors.ts` (103) | `vendors.ts` | Trimmed port: only the presets the SQLite, PostgreSQL and MySQL drivers can connect to |
| `source-dialog.tsx` (583) | `SourceDialog.tsx` | Not carried over: the local flat form stays; phase 2 only adds the vendor presets |
| `sql/lexer.ts` (159), `sql/dialect.ts` (454), `sql/analyze.ts` (571), `sql/resolve.ts` (322), `sql/complete.ts` (576), `sql/format.ts` (269), `sql/params.ts` (65), `sql/readOnly.ts` (35) | `sql/*.ts` | Ported, with `@/platform/ipc` and upstream's types replaced by this app's |
| `store.ts` (617) | `store.ts` | Reference rewrite: a window-level zustand store (tabs, query documents, results, output, settings, connection); upstream's semantics for the result-tab and output-line caps are kept, the code is first-party |
| `tab-model.ts` (43) | — | New: tab key, tab label and restoring the stored tab records |
| `query-tab.tsx` (15) | `console.tsx` | New stub: the editor and result tabs of one query file |
| `data-view.tsx` (42) | `DataView.tsx` | New stub: the editable grid a table tab and a query result share |
| `data-panel.tsx` (22) | `DataView.tsx` (panel half) | New stub: the record / value / aggregates panel |
| `plan-view.tsx` (17) | `plan.ts` | New stub: the execution plan tree and its property panel |
| `result-tabs.tsx` (16) | `ResultsView.tsx` | New stub: one tab per statement plus the output console |
| `result-actions.ts` (24) | — | New stub: rerun, page and count actions of a result tab |
| `tree-toolbar.tsx` (25) | — | New stub: the toolbar above the object tree |
| `history-dialog.tsx` (16) | `Dialogs.tsx` (history half) | New stub: the query history dialog |
| `quick-doc.tsx` (18) | — | New stub: the quick documentation popup |
| `params-dialog.tsx` (16) | — | New stub: the parameter values a script needs before it runs |
| `import-dialog.tsx` (19) | `DataDialogs.tsx` (import half) | New stub: the CSV import dialog |

Deliberately not carried over: `ChartView.tsx` and the chart series,
`Database.module.css`, and the parts of `plan.ts`, ClickHouse and Oracle that
the app does not drive. Upstream's `store.ts` was not carried over either — the
window-level store here is a first-party rewrite that reuses only its cap
semantics.

## Taking an upstream change

1. Diff the local file against `src/features/database/` in the `.dev/openidea`
   checkout.
2. Apply it by hand on top of the local rewrite, keeping Tailwind + shadcn/ui,
   the `@/commands` wrappers, English-only code strings and the i18n keys under
   `database.*`.
3. `pnpm build` and smoke-test the databases page and a data source window.
