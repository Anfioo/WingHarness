# Database Tools

The **数据库** (Databases) page manages data sources and opens each one in a
window of its own, with a SQL console. The engine is
[`src-tauri/db-core`](../../src-tauri/db-core), ported from the `crates/ide-db`
crate of [openidea](https://github.com/l0ng-ai/openidea) (Apache-2.0);
[`db-core/UPSTREAM.md`](../../src-tauri/db-core/UPSTREAM.md) records what was
carried over and what was not.

## Windows and routes

| Route | Renders |
| --- | --- |
| `/database` | The picker: the data source list, add / edit / duplicate / delete, test connection |
| `/database-window?source=<id>` | The data source window (label `database-<hash>`): object tree, console, result grid, history |

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

## The console

- **Run** executes one statement (`db_execute`), fetching at most 500 rows. More
  rows are reported as "More rows are available"; paging is a later phase.
- **Ctrl+Enter** runs, and a running statement can be cancelled. Cancellation is
  cooperative: `db_execute` registers a `CancellationToken` under a request id
  the frontend chose, `db_cancel` triggers it, and the engine uses
  `tokio::select!` (plus `pg_cancel_backend` / `KILL QUERY` where the server
  supports it; SQLite discards the connection). Because the app has no host-level
  request registry, that id map lives in `DbState`.
- **Manual commit** switches the data source's connection into a transaction
  (`db_set_manual_commit`); **Commit** and **Roll back** end it
  (`db_finish_transaction`). Leaving manual mode rolls back whatever was not
  committed, and so does disconnecting.
- **History** lists the statements the data source ran, newest first (500 kept).
  Clicking an entry puts it back in the editor; entries can be removed singly or
  all at once (`db_remove_history`).
- **Results** show each column's name and type; the summary line gives the total
  time and, when it differs, the time to the server's first answer.

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
level that fails shows its error inline. Double-clicking a table appends a
`SELECT` for it to the console. The window has one console connection, so a
table of another PostgreSQL database is not inserted — the tree points that
out. The Schemas tab's name patterns (`*`, `?`) and the object filter are
applied in the frontend, so the catalog queries stay unfiltered.

PostgreSQL sources whose `options.singleDatabase` is off show the server's
databases first and each database's schemas below it; every other driver lists
its schemas directly (for MySQL a schema *is* a database). SQLite's schema list
is `main` plus attached databases, because its catalog lives in each file.

`db_databases` is PostgreSQL-only and returns `invalid` for other drivers.
Routines and sequences are extras: a server that refuses those catalogs still
lists tables.

## Commands

| Group | Commands |
| --- | --- |
| Data sources | `db_sources`, `db_save_sources`, `db_set_password`, `db_test` |
| Connections | `db_connect`, `db_disconnect`, `db_connected` |
| Transactions | `db_set_manual_commit`, `db_finish_transaction` |
| Introspection | `db_databases`, `db_schemas`, `db_tables`, `db_table_details`, `db_schema_objects` |
| Query | `db_execute`, `db_cancel` |
| History | `db_history`, `db_remove_history` |

Every command is registered in the four lists described in
[`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md), and every database window
(`database-*`) is in `capabilities/default.json` next to `main`.

`db_cancel`, `db_sources` and `db_connected` are additions: upstream's host
registry and per-workbench lists have no equivalent here.

## Errors

A rejected command returns `DbError { code, message }`; `code` is what the
frontend branches on (`not-found`, `invalid`, `auth-failed`, `unreachable`,
`cancelled`, `protocol`, `internal`). `message` is English and **must never
contain a password** — `parse_url` and the connection errors are written with
that rule in mind, and the URL shown in the list is masked before display.

## Not ported yet

- DDL display (`db_ddl`, `db_object_ddl`), `db_explain`, `db_table_page`,
  `db_apply_edits`, `db_export_file`, `db_completion` — and the UI that uses
  them.
- Table editing, object management and export.
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
