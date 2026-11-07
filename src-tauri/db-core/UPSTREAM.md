# Origin: db-core

Derived from the `crates/ide-db` crate of
[l0ng-ai/openidea](https://github.com/l0ng-ai/openidea), the database tools of
that IDE: data sources, connections, introspection and query execution.

- Upstream version at import: **0.1.37** (workspace `version = "0.1.37"`)
- Upstream commit: **9069c322** (2026-11-06), see the `.dev/openidea` checkout
- License: Apache-2.0 — one-way compatible with this project's GPL-3.0-only.
  The full text is in `licenses/Apache-2.0.txt`.
- Imported subtree: `crates/ide-db/src/`

## Status

The crate is maintained here as first-party code. It was **not** copied
byte-for-byte: every file was reworked to this app's conventions before it was
added, so a re-sync by copying upstream over this directory would drop that
work. `crates/ide-db/src/{clickhouse,oracle}.rs` were not carried over at all,
and `plan.rs` was reduced to the three dialects this app drives.

## What was kept

| Local file | Upstream file | Notes |
|------------|---------------|-------|
| `src/source.rs` | `src/source.rs` | Data-source settings, URL parsing, the TOML store |
| `src/secrets.rs` | `src/secrets.rs` | Rewritten: one plain JSON file instead of the OS keychain |
| `src/history.rs` | `src/history.rs` | Keyed by data source id; the upstream project key is gone |
| `src/conn.rs` | `src/conn.rs` | SQLite, PostgreSQL and MySQL paths only |
| `src/split.rs` | `src/split.rs` | Statement splitting; the Oracle PL/SQL rules are gone |
| `src/manager.rs` | `src/lib.rs` | `DbManager`, without the SSH tunnels or the global/project password split; paging, row editing, DDL and completion live here |
| `src/models.rs` | `src/lib.rs` (model types) | The wire model of paging and the console: `SortKey`, `CellValue`, `DbRowEdit`, `TablePage`, `CompletionCatalog`, `StatementOutcome` |
| `src/objects.rs` | `src/lib.rs` | The introspection DTOs (`Databases`, `TableInfo`, `TableDetails`…) and the foreign-key grouping |
| `src/sql.rs` | `src/sql.rs` | The introspection queries, the table page query, the row-edit statements and the DDL builders: catalogs, columns, indexes, foreign keys, triggers, routines, sequences |
| `src/plan.rs` | `src/plan.rs` | Execution plans: the `EXPLAIN` prefix per driver and the normalization of SQLite, PostgreSQL and MySQL answers into `PlanNode`; the Oracle, SQL Server and ClickHouse branches are gone |
| `src/workspace.rs` | — | New, first-party: the query files, the persisted window tabs and the row limits |
| `src/paths.rs` | — | New: where the feature writes, below the app's data directory |
| `src/error.rs` | `src/lib.rs` (error type) | `DbError` / `DbErrorCode`, replacing `IdeError` |

## Divergences from upstream

- **No SSH tunnels.** Upstream tunnels through its `ide-ssh` crate
  (`DbSsh`, `Tunnel`, host-key trust). This port has no port-forwarding
  equivalent, so `DbSsh` / `DbSshAuth`, `db_set_ssh_secret`, `db_trust_ssh_host`
  and the SSH tab are all absent — not stubbed, absent.
- **No keychain.** Saved passwords live in `<data dir>/db/secrets.json`, which
  the UI warns about next to the checkbox. Upstream's `SecretStore` migration
  from an older plaintext file was not carried over.
- **No `specta`.** The frontend types are hand-written in
  `src/commands/services/database/`; every DTO keeps
  `#[serde(rename_all = "camelCase")]` so the wire format is unchanged.
- **SQL Server, ClickHouse and Oracle are not ported yet.** Their DTOs and the
  `DbDriver` variants remain so the stored settings stay readable, but
  `Pool::connect` rejects them with a clear error. `sql.rs` keeps those query
  builders as strings for exhaustive matches; they never run.
- **Table paging and row editing are ported with one rule added.** `sql.rs` has
  the page query (one row beyond the limit, so `hasMore` needs no `COUNT(*)`)
  and the `update` / `insert` / `delete` builders; `DbManager` has
  `table_page` and `apply_edits`. `apply_edits` runs the whole batch in one
  transaction of its own and refuses an update or delete on a table without a
  primary key. Upstream left that check to its editor; here the command is
  reachable without the editor, so the engine enforces it too.
- **DDL generation is ported read-only.** `DbManager::ddl` returns a table's or
  view's definition (SQLite stored text, MySQL `SHOW CREATE`, PostgreSQL catalog
  assembly) and `object_ddl` does the same for routines, triggers and
  sequences. Generating new-table and alter statements lives in the frontend
  (`object-sql.ts`), because it is pure string work with no connection.
- **Completion is ported as a catalog.** `DbManager::completion` returns the
  tables, columns and routines of the connection once; resolving names, CTEs and
  aliases from them is done in `src/pages/database/sql/`, which keeps the Rust
  side free of a parser.
- **Query plans are ported for three dialects.** `DbManager::explain` prefixes a
  statement with the driver's own `EXPLAIN` form, runs it and normalizes the
  answer into one `PlanNode` tree, so the frontend renders SQLite's row stream,
  PostgreSQL's nested JSON plan and MySQL's `query_block` the same way. The
  Oracle, SQL Server and ClickHouse branches of upstream's `plan.rs` were
  dropped along with the drivers.
- **The workspace is first-party.** Upstream's workbench kept its query files
  and tab layout in the IDE's own state. Here `src/workspace.rs` owns them:
  `<data dir>/db/query/*.sql`, `windows.json` and `settings.json`, written
  atomically, versioned, and backed up when a file does not parse. It has no
  upstream counterpart.
- **Still absent: export.** File export was not carried over; it goes through
  the app's existing `save_text_file`.
- **Error type.** `ide_core::IdeError { kind, message, data }` became
  `DbError { code, message }` (`DbErrorCode` is `kebab-case` on the wire), and
  the SQL Server authentication codes became `AuthFailed`.
- **Smaller substitutions.** `parking_lot::Mutex` → `std::sync::Mutex`,
  `tracing` → `log`, `futures` → `futures-util`, `ide_ssh::expand` → a local
  `~/` expansion in `conn.rs`, edition 2024 → 2021, `AppHandle`-free (the crate
  holds no Tauri state; the app constructs `DbManager`).
- **History writing** is synchronous instead of going through a recorder thread.
- **Command surface.** Upstream's commands are driven by its host's request
  registry and per-workbench lists; this crate holds neither, so `commands/db.rs`
  has 33 commands. Of the plan.1 surface, six were added here: `db_statements`,
  `db_table_page`, `db_apply_edits`, `db_ddl`, `db_object_ddl` and
  `db_completion`, alongside `db_cancel` (cancellation keyed on a
  frontend-chosen request id, kept in `DbState`), `db_sources` and
  `db_connected`. The workspace phase added nine more — `db_queries`,
  `db_query_read`, `db_query_write`, `db_query_delete`, `db_window_tabs`,
  `db_save_window_tabs`, `db_settings`, `db_save_settings` and `db_explain` —
  because upstream's workbench managed its own files and plans. The SSH
  commands are absent. The full list is in
  [`docs/features/DATABASE.md`](../../docs/features/DATABASE.md).

## Taking an upstream change

1. Diff the local file against `crates/ide-db/src/` in the `.dev/openidea`
   checkout.
2. Apply it by hand on top of the local edits, keeping this app's error type,
   path helpers and English-only strings.
3. `cargo test -p db-core` (unit tests plus the SQLite end-to-end tests in
   `tests/sqlite.rs` and the plan tests in `tests/plan.rs`) and smoke-test the
   database pages.
