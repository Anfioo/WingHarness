//! Database tools: the commands behind the data-source page and its windows.
//!
//! Thin shells over `db_core::DbManager` — the same split the reference project
//! uses (openidea, Apache-2.0; see `db-core/UPSTREAM.md`). Two things differ:
//! the commands take no window label (there is one data-source list for the
//! whole app, not one per workbench), and a running statement is cancelled by
//! request id through [`db_cancel`], because this app has no host-level request
//! registry to hang cancellation off.
//!
//! Ported from `src-tauri/src/commands/db.rs` of the reference project.

use std::collections::HashMap;
use std::sync::Mutex;

use db_core::{
    DataSource, Databases, DbManager, DbResult, HistoryEntry, QueryResult, SchemaObjects, TableDetails, TableInfo,
};
use serde::Serialize;
use tauri::State;
use tokio_util::sync::CancellationToken;

/// State the app constructs once and manages: the engine plus what is needed to
/// stop a statement that is still running.
pub struct DbState {
    pub manager: DbManager,
    /// Cancellation tokens of the statements in flight, by the id the caller chose.
    cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl DbState {
    pub fn new(manager: DbManager) -> Self {
        Self {
            manager,
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// Closes every connection before the app exits: pools left open hold
    /// sockets, and a manual-commit transaction would stay open on the server.
    pub async fn shutdown(&self) {
        for target in self.manager.connected() {
            self.manager.disconnect(&target).await;
        }
    }
}

/// The project whose data sources are listed is the one configured right now.
///
/// Read per call rather than cached at startup: the root can change in the
/// settings page, and the manager needs the new one for relative SQLite paths.
fn sync_project(state: &DbState) {
    state
        .manager
        .set_root(crate::config::load().project_root().map(str::to_owned));
}

/// A data source as the list shows it, with the fields the row needs that are
/// not part of the stored settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    #[serde(flatten)]
    source: DataSource,
    /// A pool for it is open.
    connected: bool,
    /// A password is stored for it and will be used without asking.
    has_saved_password: bool,
}

#[tauri::command]
pub fn db_sources(state: State<'_, DbState>) -> DbResult<Vec<SourceView>> {
    sync_project(&state);
    Ok(state
        .manager
        .sources()?
        .into_iter()
        .map(|source| SourceView {
            connected: state.manager.is_connected(&source.id),
            // The engine never exposes a stored password, so the list can only
            // say one exists; the data source says whether it would be used.
            has_saved_password: source.save_password,
            source,
        })
        .collect())
}

#[tauri::command]
pub async fn db_save_sources(state: State<'_, DbState>, sources: Vec<DataSource>) -> DbResult<()> {
    sync_project(&state);
    state.manager.save_sources(sources).await
}

/// Remembers the password for this session, and in the saved passwords when
/// `save` is set. `None` forgets it.
#[tauri::command]
pub fn db_set_password(
    state: State<'_, DbState>,
    id: String,
    password: Option<String>,
    save: bool,
) -> DbResult<()> {
    state.manager.set_password(&id, password, save)
}

/// Connects with the settings as given (not necessarily saved) and returns what
/// the server calls itself. Closes the connection afterwards.
#[tauri::command]
pub async fn db_test(
    state: State<'_, DbState>,
    source: DataSource,
    password: Option<String>,
) -> DbResult<String> {
    sync_project(&state);
    state.manager.test(&source, password).await
}

/// Connected targets, as `<data source id>` or `<data source id>:<database>`.
#[tauri::command]
pub fn db_connected(state: State<'_, DbState>) -> DbResult<Vec<String>> {
    Ok(state.manager.connected())
}

#[tauri::command]
pub async fn db_connect(state: State<'_, DbState>, id: String) -> DbResult<()> {
    sync_project(&state);
    state.manager.pool(&id).await?;
    Ok(())
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, id: String) -> DbResult<()> {
    state.manager.disconnect(&id).await;
    Ok(())
}

/// The databases of a PostgreSQL server; the data source's own one is
/// `current`. Connect to another as `<id>:<database>`.
#[tauri::command]
pub async fn db_databases(state: State<'_, DbState>, id: String) -> DbResult<Databases> {
    sync_project(&state);
    state.manager.databases(&id).await
}

#[tauri::command]
pub async fn db_schemas(state: State<'_, DbState>, id: String) -> DbResult<Vec<String>> {
    sync_project(&state);
    state.manager.schemas(&id).await
}

#[tauri::command]
pub async fn db_tables(
    state: State<'_, DbState>,
    id: String,
    schema: String,
) -> DbResult<Vec<TableInfo>> {
    sync_project(&state);
    state.manager.tables(&id, &schema).await
}

#[tauri::command]
pub async fn db_table_details(
    state: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> DbResult<TableDetails> {
    sync_project(&state);
    state.manager.table_details(&id, &schema, &table).await
}

#[tauri::command]
pub async fn db_schema_objects(
    state: State<'_, DbState>,
    id: String,
    schema: String,
) -> DbResult<SchemaObjects> {
    sync_project(&state);
    state.manager.schema_objects(&id, &schema).await
}

#[tauri::command]
pub async fn db_set_manual_commit(
    state: State<'_, DbState>,
    id: String,
    manual: bool,
) -> DbResult<()> {
    sync_project(&state);
    state.manager.set_manual_commit(&id, manual).await
}

#[tauri::command]
pub async fn db_finish_transaction(
    state: State<'_, DbState>,
    id: String,
    commit: bool,
) -> DbResult<()> {
    state.manager.finish_transaction(&id, commit).await
}

/// Runs one statement. `request` identifies it for [`db_cancel`]; `skip` and
/// `max_rows` select a window of the result without decoding the rows before it.
#[tauri::command]
pub async fn db_execute(
    state: State<'_, DbState>,
    request: String,
    id: String,
    statement: String,
    skip: u32,
    max_rows: u32,
) -> DbResult<QueryResult> {
    sync_project(&state);
    let cancel = {
        let mut cancels = state.cancels.lock().unwrap_or_else(|p| p.into_inner());
        cancels.insert(request.clone(), CancellationToken::new());
        cancels
            .get(&request)
            .cloned()
            .expect("inserted just above")
    };

    let result = state
        .manager
        .execute_from(&id, &statement, skip as usize, max_rows as usize, &cancel)
        .await;

    state
        .cancels
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&request);
    result
}

/// Asks the statement running as `request` to stop. Returns whether it was
/// still running — a statement that already finished cannot be cancelled.
#[tauri::command]
pub fn db_cancel(state: State<'_, DbState>, request: String) -> bool {
    match state
        .cancels
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&request)
    {
        Some(cancel) => {
            cancel.cancel();
            true
        }
        None => false,
    }
}

#[tauri::command]
pub async fn db_history(state: State<'_, DbState>, id: String) -> DbResult<Vec<HistoryEntry>> {
    state.manager.history(&id).await
}

/// Forgets statements of a data source's history; all of them when `texts` is
/// `None`.
#[tauri::command]
pub async fn db_remove_history(
    state: State<'_, DbState>,
    id: String,
    texts: Option<Vec<String>>,
) -> DbResult<()> {
    state.manager.remove_history(&id, texts).await
}
