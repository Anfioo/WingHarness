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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use db_core::{
    CompletionModel, DataSource, Databases, DbError, DbManager, DbObjectKind, DbResult, DbRowEdit,
    DbSettings, HistoryEntry, PlanNode, QueryFile, SchemaObjects, SortKey, SqlStatement,
    StatementOutcome, TableDetails, TableInfo, TablePage, WindowTabs, Workspace,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;

/// Every id the project panel creates starts with this, which is what routes a
/// command to the project-scoped manager instead of the app-wide one.
pub const PROJECT_ID_PREFIX: &str = "whp-";

/// Which of the two managers a scope-aware command works on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbScope {
    #[default]
    App,
    Project,
}

/// The project-scoped engine, rebuilt when the configured root changes.
struct ProjectDb {
    root: String,
    manager: Arc<DbManager>,
    workspace: Workspace,
}

/// State the app constructs once and manages: the engines plus what is needed
/// to stop a statement that is still running.
pub struct DbState {
    /// The app-wide data sources, listed in every project.
    pub app: Arc<DbManager>,
    pub app_workspace: Workspace,
    /// Built lazily from the configured project root; rebuilt when the root
    /// changes.
    project: Mutex<Option<Arc<ProjectDb>>>,
    /// `<data dir>/db/secrets.json`, shared by both scopes.
    secrets_path: PathBuf,
    /// Cancellation tokens of the statements in flight, by the id the caller chose.
    cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl DbState {
    pub fn new(manager: DbManager, workspace: Workspace, secrets_path: PathBuf) -> Self {
        Self {
            app: Arc::new(manager),
            app_workspace: workspace,
            project: Mutex::new(None),
            secrets_path,
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// Closes every connection before the app exits: pools left open hold
    /// sockets, and a manual-commit transaction would stay open on the server.
    pub async fn shutdown(&self) {
        for target in self.app.connected() {
            self.app.disconnect(&target).await;
        }
        let project = self.project.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(project) = project {
            for target in project.manager.connected() {
                project.manager.disconnect(&target).await;
            }
        }
    }

    /// The project-scoped engine of the configured root, or `None` when no
    /// project is open. A root change builds a new one and closes the old
    /// connections off the command's path.
    fn project(&self) -> DbResult<Option<Arc<ProjectDb>>> {
        let Some(root) = crate::config::load().project_root().map(str::to_owned) else {
            return Ok(None);
        };
        let mut slot = self.project.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = slot.as_ref().filter(|existing| existing.root == root) {
            return Ok(Some(existing.clone()));
        }
        let data_dir = db_core::paths::project_data_dir(&root);
        let manager = Arc::new(DbManager::new_project(data_dir.clone(), self.secrets_path.clone()));
        manager.set_root(Some(root.clone()));
        let created = Arc::new(ProjectDb { root, manager, workspace: Workspace::new(data_dir) });
        let previous = slot.replace(created.clone());
        drop(slot);
        if let Some(previous) = previous {
            let _ = tauri::async_runtime::spawn(async move {
                for target in previous.manager.connected() {
                    previous.manager.disconnect(&target).await;
                }
            });
        }
        Ok(Some(created))
    }

    /// The engine a data source id belongs to: `whp-` prefixed ids are the
    /// project's, everything else the app's.
    fn manager_for(&self, id: &str) -> DbResult<Arc<DbManager>> {
        if !id.starts_with(PROJECT_ID_PREFIX) {
            return Ok(self.app.clone());
        }
        self.project()?
            .map(|project| project.manager.clone())
            .ok_or_else(|| DbError::invalid("Project data sources need an open project"))
    }

    /// The query files and settings a scope-aware command works on.
    fn workspace_for(&self, scope: Option<DbScope>) -> DbResult<Workspace> {
        match scope.unwrap_or_default() {
            DbScope::App => Ok(self.app_workspace.clone()),
            DbScope::Project => self
                .project()?
                .map(|project| project.workspace.clone())
                .ok_or_else(|| DbError::invalid("Project data sources need an open project")),
        }
    }
}

/// The project whose data sources are listed is the one configured right now.
///
/// Read per call rather than cached at startup: the root can change in the
/// settings page, and the manager needs the new one for relative SQLite paths.
fn sync_project(state: &DbState) {
    state.app.set_root(crate::config::load().project_root().map(str::to_owned));
}

/// The manager of data source `id` with the project root refreshed first.
fn manager_for(state: &DbState, id: &str) -> DbResult<Arc<DbManager>> {
    sync_project(state);
    state.manager_for(id)
}

/// The manager a scope-aware command asked for. Source-list commands name the
/// scope explicitly because they have no id to route by.
fn manager_for_scope(state: &DbState, scope: Option<DbScope>) -> DbResult<Arc<DbManager>> {
    sync_project(state);
    match scope.unwrap_or_default() {
        DbScope::App => Ok(state.app.clone()),
        DbScope::Project => state
            .project()?
            .map(|project| project.manager.clone())
            .ok_or_else(|| DbError::invalid("Project data sources need an open project")),
    }
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
pub fn db_sources(state: State<'_, DbState>, scope: Option<DbScope>) -> DbResult<Vec<SourceView>> {
    let manager = manager_for_scope(&state, scope)?;
    Ok(manager
        .sources()?
        .into_iter()
        .map(|source| SourceView {
            connected: manager.is_connected(&source.id),
            // The engine never exposes a stored password, so the list can only
            // say one exists; the data source says whether it would be used.
            has_saved_password: source.save_password,
            source,
        })
        .collect())
}

#[tauri::command]
pub async fn db_save_sources(
    state: State<'_, DbState>,
    sources: Vec<DataSource>,
    scope: Option<DbScope>,
) -> DbResult<()> {
    manager_for_scope(&state, scope)?.save_sources(sources).await
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
    manager_for(&state, &id)?.set_password(&id, password, save)
}

/// Connects with the settings as given (not necessarily saved) and returns what
/// the server calls itself. Closes the connection afterwards.
#[tauri::command]
pub async fn db_test(
    state: State<'_, DbState>,
    source: DataSource,
    password: Option<String>,
) -> DbResult<String> {
    manager_for(&state, &source.id)?.test(&source, password).await
}

/// Connected targets, as `<data source id>` or `<data source id>:<database>`.
#[tauri::command]
pub fn db_connected(state: State<'_, DbState>) -> DbResult<Vec<String>> {
    let mut targets = state.app.connected();
    if let Some(project) = state.project()? {
        targets.extend(project.manager.connected());
    }
    Ok(targets)
}

#[tauri::command]
pub async fn db_connect(state: State<'_, DbState>, id: String) -> DbResult<()> {
    manager_for(&state, &id)?.pool(&id).await?;
    Ok(())
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, id: String) -> DbResult<()> {
    manager_for(&state, &id)?.disconnect(&id).await;
    Ok(())
}

/// The databases of a PostgreSQL server; the data source's own one is
/// `current`. Connect to another as `<id>:<database>`.
#[tauri::command]
pub async fn db_databases(state: State<'_, DbState>, id: String) -> DbResult<Databases> {
    manager_for(&state, &id)?.databases(&id).await
}

#[tauri::command]
pub async fn db_schemas(state: State<'_, DbState>, id: String) -> DbResult<Vec<String>> {
    manager_for(&state, &id)?.schemas(&id).await
}

#[tauri::command]
pub async fn db_tables(
    state: State<'_, DbState>,
    id: String,
    schema: String,
) -> DbResult<Vec<TableInfo>> {
    manager_for(&state, &id)?.tables(&id, &schema).await
}

#[tauri::command]
pub async fn db_table_details(
    state: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> DbResult<TableDetails> {
    manager_for(&state, &id)?.table_details(&id, &schema, &table).await
}

#[tauri::command]
pub async fn db_schema_objects(
    state: State<'_, DbState>,
    id: String,
    schema: String,
) -> DbResult<SchemaObjects> {
    manager_for(&state, &id)?.schema_objects(&id, &schema).await
}

/// The tables, columns and foreign keys the SQL editor completes names from.
#[tauri::command]
pub async fn db_completion(state: State<'_, DbState>, id: String) -> DbResult<CompletionModel> {
    manager_for(&state, &id)?.completion(&id).await
}

#[tauri::command]
pub async fn db_set_manual_commit(
    state: State<'_, DbState>,
    id: String,
    manual: bool,
) -> DbResult<()> {
    manager_for(&state, &id)?.set_manual_commit(&id, manual).await
}

#[tauri::command]
pub async fn db_finish_transaction(
    state: State<'_, DbState>,
    id: String,
    commit: bool,
) -> DbResult<()> {
    manager_for(&state, &id)?.finish_transaction(&id, commit).await
}

/// One page of a table, ordered and filtered on the server. `request`
/// identifies it for [`db_cancel`], as [`db_execute`] does.
#[tauri::command]
pub async fn db_table_page(
    state: State<'_, DbState>,
    request: String,
    id: String,
    schema: String,
    table: String,
    filter: Option<String>,
    sort: Vec<SortKey>,
    offset: u64,
    limit: u64,
) -> DbResult<TablePage> {
    let manager = manager_for(&state, &id)?;
    let cancel = {
        let mut cancels = state.cancels.lock().unwrap_or_else(|p| p.into_inner());
        cancels.insert(request.clone(), CancellationToken::new());
        cancels
            .get(&request)
            .cloned()
            .expect("inserted just above")
    };

    let result = manager
        .table_page(&id, &schema, &table, filter.as_deref(), &sort, offset, limit, &cancel)
        .await;

    state
        .cancels
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&request);
    result
}

/// Applies the pending row edits in one transaction; `Err` rolls all of them
/// back.
#[tauri::command]
pub async fn db_apply_edits(
    state: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
    edits: Vec<DbRowEdit>,
) -> DbResult<f64> {
    manager_for(&state, &id)?.apply_edits(&id, &schema, &table, &edits).await
}

/// The `CREATE TABLE` statement of a table, read-only.
#[tauri::command]
pub async fn db_ddl(
    state: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> DbResult<String> {
    manager_for(&state, &id)?.ddl(&id, &schema, &table).await
}

/// The definition of a routine, trigger or sequence, read-only.
#[tauri::command]
pub async fn db_object_ddl(
    state: State<'_, DbState>,
    id: String,
    schema: String,
    kind: DbObjectKind,
    name: String,
) -> DbResult<String> {
    manager_for(&state, &id)?.object_ddl(&id, &schema, kind, &name).await
}

/// Splits `text` into the statements the editor runs. `from` and `to` are
/// UTF-16 offsets of a selection; an empty selection means the statement at
/// the caret.
#[tauri::command]
pub fn db_statements(
    state: State<'_, DbState>,
    id: String,
    text: String,
    from: u32,
    to: u32,
) -> DbResult<Vec<SqlStatement>> {
    let driver = manager_for(&state, &id)?.source(&id)?.driver;
    Ok(if from == to {
        db_core::split::statement_at(&text, from, driver).into_iter().collect()
    } else {
        db_core::split::statements_in(&text, from, to, driver)
    })
}

/// Runs a batch of statements in order. `request` identifies the batch for
/// [`db_cancel`]; `skip` and `max_rows` select a window of each result.
#[tauri::command]
pub async fn db_execute(
    state: State<'_, DbState>,
    request: String,
    id: String,
    statements: Vec<SqlStatement>,
    skip: u32,
    max_rows: u32,
) -> DbResult<Vec<StatementOutcome>> {
    let manager = manager_for(&state, &id)?;
    let cancel = {
        let mut cancels = state.cancels.lock().unwrap_or_else(|p| p.into_inner());
        cancels.insert(request.clone(), CancellationToken::new());
        cancels
            .get(&request)
            .cloned()
            .expect("inserted just above")
    };

    let result = manager
        .execute_all(&id, &statements, skip as usize, max_rows as usize, &cancel)
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
    manager_for(&state, &id)?.history(&id).await
}

/// Forgets statements of a data source's history; all of them when `texts` is
/// `None`.
#[tauri::command]
pub async fn db_remove_history(
    state: State<'_, DbState>,
    id: String,
    texts: Option<Vec<String>>,
) -> DbResult<()> {
    manager_for(&state, &id)?.remove_history(&id, texts).await
}

/// The `.sql` files the "Open Query" list shows.
#[tauri::command]
pub fn db_queries(state: State<'_, DbState>, scope: Option<DbScope>) -> DbResult<Vec<QueryFile>> {
    state.workspace_for(scope)?.queries()
}

#[tauri::command]
pub fn db_query_read(
    state: State<'_, DbState>,
    name: String,
    scope: Option<DbScope>,
) -> DbResult<String> {
    state.workspace_for(scope)?.read_query(&name)
}

#[tauri::command]
pub fn db_query_write(
    state: State<'_, DbState>,
    name: String,
    text: String,
    scope: Option<DbScope>,
) -> DbResult<()> {
    state.workspace_for(scope)?.write_query(&name, &text)
}

#[tauri::command]
pub fn db_query_delete(
    state: State<'_, DbState>,
    name: String,
    scope: Option<DbScope>,
) -> DbResult<()> {
    state.workspace_for(scope)?.delete_query(&name)
}

/// The tabs `source` had when its window was last closed.
#[tauri::command]
pub async fn db_window_tabs(
    state: State<'_, DbState>,
    source: String,
) -> DbResult<Option<WindowTabs>> {
    state.app_workspace.window_tabs(&source)
}

#[tauri::command]
pub async fn db_save_window_tabs(state: State<'_, DbState>, tabs: WindowTabs) -> DbResult<()> {
    state.app_workspace.save_window_tabs(tabs)
}

#[tauri::command]
pub fn db_settings(state: State<'_, DbState>, scope: Option<DbScope>) -> DbResult<DbSettings> {
    state.workspace_for(scope)?.settings()
}

#[tauri::command]
pub async fn db_save_settings(
    state: State<'_, DbState>,
    settings: DbSettings,
    scope: Option<DbScope>,
) -> DbResult<()> {
    state.workspace_for(scope)?.save_settings(settings)
}

/// The execution plan of `statement` against data source `id`.
#[tauri::command]
pub async fn db_explain(
    state: State<'_, DbState>,
    id: String,
    statement: String,
) -> DbResult<Vec<PlanNode>> {
    manager_for(&state, &id)?.explain(&id, &statement).await
}
