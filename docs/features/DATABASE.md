# Database Tools

The **数据库** (Databases) page manages data sources and opens each one in a
window of its own. A window is a tabbed workspace: a SQL console, plus one data
tab per table opened from the object tree. The engine is
[`src-tauri/db-core`](../../src-tauri/db-core), ported from the `crates/ide-db`
crate of [openidea](https://github.com/l0ng-ai/openidea) (Apache-2.0);
[`db-core/UPSTREAM.md`](../../src-tauri/db-core/UPSTREAM.md) records what was
carried over and what was not.

## Windows and routes

| Route | Renders |
| --- | --- |
| `/database` | The picker: the data source list, add / edit / duplicate / delete, test connection |
| `/database-window?source=<id>` | The data source window (label `database-<hash>`): tab strip (console + table tabs), object tree, editor, result grid, history |

A window label may only contain alphanumerics and `-`, `/`, `:`, `_`, so the id
is hashed instead of embedded: `database-` plus a 16-hex FNV-1a digest
(`hashedWindowLabel` in `src/lib/window-label.ts`). Opening the same data source
twice focuses the window already open instead of stacking a duplicate. The id
itself travels in the query string, because `main.tsx` routes on `pathname`
alone and the window's page reads the query itself.

## Data sources

One data source is one server or one SQLite file. The stored fields are the ones
`db-core/src/source.rs` defines:

| Field | Meaning |
| --- | --- |
| `driver` | `sqlite`, `postgres`, `mysql`, `sqlServer`, `clickhouse`, `oracle` |
| `file` | SQLite database file; a relative path resolves against the project root |
| `host` / `port` / `database` / `user` | The server connection |
| `urlOnly` / `url` | Connect with one URL instead of the fields above (`jdbc:` accepted) |
| `ssl` | `disable`, `prefer` (default), `require`, `verifyCa`, `verifyFull` |
| `savePassword` | Whether a stored password may be used |
| `readOnly` | Refuse statements other than queries |
| `global` | Stored app-wide instead of per project |
| `options.transaction` | `auto`, or `manual` (the console commits explicitly) |
| `color`, `comment`, `vendor`, `properties`, `introspection` | Presentation and advanced settings |

**Scope.** A data source is app-wide (`global`) or belongs to the project that
is open. Project sources need a project root (`config.json`'s
`workspace.root`); with none open the dialog keeps the switch on app-wide and
the engine rejects a project source with `invalid`. A project data source wins
over a global one of the same id.

**Passwords never enter the data-source files or the DTOs.** They go through
`db_set_password`, which keeps a session copy in memory and, when asked, writes
the saved copy. The list only reports `hasSavedPassword`; there is no command
that reads a password back.

**Vendor presets.** The driver select has a vendor list above it (`vendors.ts`):
PostgreSQL, MySQL and the wire-compatible servers around them (Aurora,
CockroachDB, MariaDB, Neon, Supabase, TimescaleDB, TiDB, …). A preset fills only
the driver, port, SSL requirement and URL scheme; it does not change the host,
the database or the user, and it does not decide whether the form connects with
a URL — the hint under the field says so.

## Storage

Everything is under one directory, `<data dir>/db`, so moving the data directory
moves the feature:

```
<data dir>/db/
├── data-sources.toml                        # the app-wide data sources
├── projects/<slug>-<hash>/data-sources.toml # one directory per project root
├── secrets.json                             # saved passwords, plain text
└── history.json                             # query history, by data source id
```

`secrets.json` is **not** encrypted and is not in the OS keychain — that is a
deliberate divergence from upstream, and the dialog's checkbox says so. The
`<slug>-<hash>` folder name keeps projects whose paths slug the same apart
(`c:\work\app` and `d:\work\app` are different folders).

## Connecting

`db_connect` builds a pool for the data source id and caches it in `DbManager`;
`db_connect` on an already-open source is a cheap no-op, which is why the window
can call it on every mount. Pools are closed by `db_disconnect`, by deleting or
editing the data source, and on app exit (`DbState::shutdown`).

The engine reaches PostgreSQL, MySQL/MariaDB and SQLite today. **SQL Server,
ClickHouse and Oracle can be stored but not connected**: `Pool::connect` rejects
them with a clear error, and porting them is a later phase.

Connection targets are either `<source id>` (its configured database) or
`<source id>:<database>`; ids never contain `:`.

## The window's tabs

The console is the first tab and has no close button. Double-clicking a table
opens `schema.table` as a second tab; double-clicking the same table again only
switches to the tab that is already there, and a table of another PostgreSQL
database gets a tab of its own because the tab key includes the connection
target. Closing the active tab returns to the console. The tabs live in React
state (`window-tabs.tsx`) and are not persisted: closing the window loses them.

## The console

- **Run** (`Ctrl+Enter`) executes the statement at the caret, or the selection
  when there is one; **Run all** (`Ctrl+Shift+Enter`) executes the whole editor.
  `db_statements` splits the text with the driver's quoting rules — a `;` inside
  a string, a comment or a PostgreSQL `$$` body does not end a statement — and
  both it and the editor work in UTF-16 offsets, so a caret or selection maps
  exactly to what the editor shows. A caret between two statements stays on the
  previous one unless a blank line separates them.
- **A batch is one `db_execute` call.** The statements run in order and the
  engine **stops at the first failure**: what ran before keeps its result, what
  comes after never runs, and the error lands in that statement's own
  `StatementOutcome` instead of rejecting the call, so the batch still comes
  back. Cancellation is the exception — it fails the whole call with `cancelled`.
- **Results** are per statement. Statements that return columns get a
  `Result N` tab (the last successful one is selected); statements without
  columns (DML, DDL) appear only in **Output**, with their affected-row count.
  A failing statement is marked in red there.
- **SQL intelligence** lives in `src/pages/database/sql/`: completion for
  tables, columns, aliases, CTEs, joins, functions, keywords and types;
  diagnostics for names the model cannot resolve; documentation for the item
  being completed; and formatting (`Ctrl+Alt+L`, the selection when there is
  one). The model comes from `db_completion` once per connection and is shared
  with the table editor's filter box.
- **Cancel** stops a running batch. Cancellation is cooperative: `db_execute`
  registers a `CancellationToken` under a request id the frontend chose,
  `db_cancel` triggers it, and the engine uses `tokio::select!` (plus
  `pg_cancel_backend` / `KILL QUERY` where the server supports it; SQLite
  discards the connection). Because the app has no host-level request registry,
  that id map lives in `DbState`.
- **Manual commit** switches the data source's connection into a transaction
  (`db_set_manual_commit`); **Commit** and **Roll back** end it
  (`db_finish_transaction`). Leaving manual mode rolls back whatever was not
  committed, and so does disconnecting.
- **History** lists the statements the data source ran, newest first (500 kept).
  Clicking an entry puts it back in the editor; entries can be removed singly or
  all at once (`db_remove_history`).

## The result grid

`result-grid.tsx` is one virtualized grid (28 px rows) shared by query results
and table data: drag-to-resize columns, arrow and Shift selection, `Ctrl+C` for
TSV and `Ctrl+Shift+C` for CSV of the selected block, double-click for the full
cell, and `NULL` rendered in grey italics. A click on a header sorts; a
per-column filter picks from the values the grid received.

In a query result both are local, because a result has no server-side page to
re-query. In the table editor the same actions set a `SortKey` or a `WHERE`
fragment and the page is fetched again, so they apply to the whole table.

Results page at 100, 500 or 1000 rows and the range reads `1-500 of 501+` while
more rows exist. **Export** writes CSV, TSV, JSON, SQL or Markdown through the
native save dialog and the existing `save_text_file` command — there is no
`db_export_file`.

## Table data

A table tab shows one page of `db_table_page`, fetched with `LIMIT limit + 1`:
the extra row decides `hasMore` without a `COUNT(*)`.

**Editing needs a primary key.** Without one — a table with no key, or a view —
the grid is read only and the toolbar says why; the backend refuses an update or
delete on such a table with `invalid` even when the request bypasses the UI. The
editor marks changed cells, added rows and deleted rows; **Submit** first shows
how many rows the batch will change.

**One submit is one transaction.** The frontend sends `DbRowEdit[]`
(`update` / `insert` / `delete`) to `db_apply_edits`; the engine builds the DML
and runs it in a `Pool::transaction` of its own — never inside the console's
manual-commit transaction, so a submit cannot land half-applied next to work the
user has not committed. Every `update` and `delete` must change exactly one row
(MySQL's "0 rows" means "unchanged" and is not treated as a failure). Any
failure rolls the whole batch back and keeps the draft, so the user can fix the
row and submit again.

## The object tree

The window's left panel browses the objects of the data source:

```
databases (PostgreSQL) → schemas → ┬ tables
                                   ├ views
                                   ├ materialized views
                                   ├ routines
                                   └ sequences
                                        ↓ a table
                                      columns
```

Every level is loaded the first time it is expanded — `db_databases`,
`db_schemas`, `db_tables`, `db_table_details`, `db_schema_objects`. Refresh
re-reads the levels that are already loaded and keeps the expanded nodes; a
level that fails shows its error inline. Double-clicking a table opens it as a
tab, and the tooltip says so; `Ctrl`+double-click appends a `SELECT` for it to
the console instead. The window has one console connection, so a table of
another PostgreSQL database cannot be inserted — the tree points that out. The
Schemas tab's name patterns (`*`, `?`) and the object filter are applied in the
frontend, so the catalog queries stay unfiltered.

PostgreSQL sources whose `options.singleDatabase` is off show the server's
databases first and each database's schemas below it; every other driver lists
its schemas directly (for MySQL a schema *is* a database). SQLite's schema list
is `main` plus attached databases, because its catalog lives in each file.

`db_databases` is PostgreSQL-only and returns `invalid` for other drivers.
Routines and sequences are extras: a server that refuses those catalogs still
lists tables.

## Object management

Right-clicking a node opens a menu built by `tree-menu.ts`. Entries that do not
apply are returned **disabled** rather than left out, so the menu keeps a stable
shape: a view cannot be truncated or modified, SQLite cannot rename a view, and
so on. The reason is the entry's own tooltip.

Every entry is **preview then execute**. The SQL comes from the pure functions
in `object-sql.ts`, `sql-preview.tsx` shows it, and nothing is sent until the
user confirms — the preview can also send the statement to the console instead
of running it. Confirming goes through the ordinary `db_execute`, so there is no
separate DDL command to keep in step, and the tree refreshes afterwards.

- **New table / Rename / Drop / Truncate / Modify table** — the generated
  statement with its options (`IF EXISTS` on drop, `CASCADE` on PostgreSQL,
  `RESTART IDENTITY` on truncate). The modify dialog edits columns through a
  draft model in `table-editor-model.ts`; SQLite only allows rename, add and
  drop, and the dialog says so.
- **Show DDL** — `db_ddl` for a table or view, `db_object_ddl` for a routine,
  trigger or sequence. Both only read: SQLite returns the stored text, MySQL
  runs `SHOW CREATE`, PostgreSQL assembles the statement from the catalog, and a
  definition that cannot be read is `not-found`, never a half statement.
- **SQL scripts** (select all, select first 10, insert, update, delete) insert
  the generated statement into the console without running it.

## Commands

| Group | Commands |
| --- | --- |
| Data sources | `db_sources`, `db_save_sources`, `db_set_password`, `db_test` |
| Connections | `db_connect`, `db_disconnect`, `db_connected` |
| Transactions | `db_set_manual_commit`, `db_finish_transaction` |
| Introspection | `db_databases`, `db_schemas`, `db_tables`, `db_table_details`, `db_schema_objects` |
| Query | `db_execute`, `db_statements`, `db_cancel` |
| Table data | `db_table_page`, `db_apply_edits` |
| Definitions | `db_ddl`, `db_object_ddl` |
| Completion | `db_completion` |
| History | `db_history`, `db_remove_history` |

`db_execute` takes a `SqlStatement[]` and returns a `StatementOutcome[]`; the
six additions to the earlier 18 commands are `db_statements`, `db_table_page`,
`db_apply_edits`, `db_ddl`, `db_object_ddl` and `db_completion`.

Every command is registered in the four lists described in
[`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md), and every database window
(`database-*`) is in `capabilities/default.json` next to `main`.

`db_cancel`, `db_sources`, `db_connected`, `db_statements`, `db_table_page`,
`db_apply_edits`, `db_ddl`, `db_object_ddl` and `db_completion` are additions:
upstream's host registry and per-workbench lists have no equivalent here, and
upstream's paging, editing and DDL work was reached through its own command
surface rather than this one.

## Errors

A rejected command returns `DbError { code, message }`; `code` is what the
frontend branches on (`not-found`, `invalid`, `auth-failed`, `unreachable`,
`cancelled`, `protocol`, `internal`). `message` is English and **must never
contain a password** — `parse_url` and the connection errors are written with
that rule in mind, and the URL shown in the list is masked before display.

## Not ported yet

- Query plans (`db_explain`) and the chart view — out of scope, not stubs.
- Row import (CSV import and its dialogs) and `db_export_file`: export goes
  through `save_text_file`, which the app already has.
- SQL Server, ClickHouse and Oracle connections.
- SSH tunnelling — deliberately absent, not stubbed: no `DbSsh` settings, no SSH
  tab, no `db_set_ssh_secret` / `db_trust_ssh_host` commands.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `auth-failed` when connecting | No saved password and none typed; the window asks for one |
| `invalid: Project data sources need an open project` | The data source is project-scoped but `workspace.root` is empty |
| "not allowed by ACL" | Command missing from `build.rs` or `capabilities/default.json` |
| The list shows a source as not connected after using it | `connected` is read when the list loads; use Refresh |
| `unreachable` for SQL Server / ClickHouse / Oracle | Those drivers are stored but not implemented yet |
| The password is asked for again after an edit | Changing a data source drops its session password by design |
| A table tab is read only | The table has no primary key, or it is a view; update and delete need a key to locate the row |
| A table of another PostgreSQL database will not insert into the console | The window has one connection; open it as a tab instead |
| Only part of a pasted script ran | Statements run in order and stop at the first failure; the failing one is marked in Output |
