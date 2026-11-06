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
work. `crates/ide-db/src/{clickhouse,oracle,plan}.rs` were not carried over at
all.

## What was kept

| Local file | Upstream file | Notes |
|------------|---------------|-------|
| `src/source.rs` | `src/source.rs` | Data-source settings, URL parsing, the TOML store |
| `src/secrets.rs` | `src/secrets.rs` | Rewritten: one plain JSON file instead of the OS keychain |
| `src/history.rs` | `src/history.rs` | Keyed by data source id; the upstream project key is gone |
| `src/conn.rs` | `src/conn.rs` | SQLite, PostgreSQL and MySQL paths only |
| `src/split.rs` | `src/split.rs` | Statement splitting; the Oracle PL/SQL rules are gone |
| `src/manager.rs` | `src/lib.rs` | `DbManager`, without the SSH tunnels or the global/project password split |
| `src/objects.rs` | `src/lib.rs` | The introspection DTOs (`Databases`, `TableInfo`, `TableDetails`…) and the foreign-key grouping |
| `src/sql.rs` | `src/sql.rs` | The introspection queries only: catalogs, columns, indexes, foreign keys, triggers, routines, sequences |
| `src/paths.rs` | — | New: where the feature writes, below the app's data directory |

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
- **Table paging, row editing and DDL generation are not ported yet.** `sql.rs`
  therefore has no `table_page`, `edit_statement` or `postgres_table_ddl`, and
  `DbManager` has no `table_page`, `apply_edits`, `ddl`, `object_ddl`,
  `explain`, `completion` or `export`. Introspection (`databases`, `schemas`,
  `tables`, `table_details`, `schema_objects`) is ported and used by the object
  tree.
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
  adds `db_cancel` (cancellation keyed on a frontend-chosen request id, kept in
  `DbState`), `db_sources` and `db_connected`. The SSH commands are absent. The
  full list is in [`docs/features/DATABASE.md`](../../docs/features/DATABASE.md).

## Taking an upstream change

1. Diff the local file against `crates/ide-db/src/` in the `.dev/openidea`
   checkout.
2. Apply it by hand on top of the local edits, keeping this app's error type,
   path helpers and English-only strings.
3. `cargo test -p db-core` (unit tests plus the SQLite end-to-end tests in
   `tests/sqlite.rs`) and smoke-test the database pages.
