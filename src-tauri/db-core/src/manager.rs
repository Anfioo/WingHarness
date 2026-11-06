//! The manager the commands talk to: data sources, live pools, transactions and
//! the query history.
//!
//! Ported from `DbManager` in the reference project's `ide_db` crate
//! (Apache-2.0), with the SSH tunnels, the per-project password files and the
//! recorder thread removed. There is one file for the data sources of every
//! project and the app-wide ones, one for passwords and one for history, all
//! below the data directory this manager is constructed with.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::conn::{self, Held, Pool, QueryResult};
use crate::error::{DbError, DbResult};
use crate::history::{HistoryEntry, HistoryStore};
use crate::models::{CompletionModel, DbRowEdit, SortKey, StatementOutcome, TablePage};
use crate::objects::{
    self, ColumnInfo, Databases, DbObjectKind, DbTableKind, IndexInfo, RoutineInfo, SchemaObjects, SequenceInfo,
    TableDetails, TableInfo, TriggerInfo,
};
use crate::paths;
use crate::secrets::SecretStore;
use crate::source::{self, DataSource, DbDriver};
use crate::split::SqlStatement;
use crate::sql;

/// Connection target: a data source id (its configured database), or
/// `<id>:<database>` for another database of the same server. Data source ids
/// never contain `:`.
pub fn split_target(target: &str) -> (&str, Option<&str>) {
    match target.split_once(':') {
        Some((id, database)) if !database.is_empty() => (id, Some(database)),
        Some((id, _)) => (id, None),
        None => (target, None),
    }
}

type Session = Arc<tokio::sync::Mutex<Option<Held>>>;

/// Rows a catalog query may return before it is cut off.
const MAX_META_ROWS: usize = 100_000;

pub struct DbManager {
    /// `<data dir>/db`, the root of everything this feature writes.
    data_dir: PathBuf,
    /// The open project, whose data sources are listed next to the global ones
    /// and whose root resolves relative SQLite paths.
    root: Mutex<Option<String>>,
    pools: Mutex<HashMap<String, Arc<Pool>>>,
    secrets: SecretStore,
    history: Arc<HistoryStore>,
    /// Passwords entered this session (not saved, or not yet), by data source id.
    session_passwords: Mutex<HashMap<String, String>>,
    /// Manual-commit targets, each with the connection of its open transaction
    /// (taken by the first statement after a commit / rollback).
    sessions: Mutex<HashMap<String, Session>>,
}

/// Rolls back a session's transaction and releases its connection.
async fn end_session(session: &Session) {
    let held = session.lock().await.take();
    if let Some(mut connection) = held {
        if connection.command("ROLLBACK").await.is_err() {
            connection.discard().await;
        }
    }
}

/// Options › keep-alive: pings the pool until it is closed or dropped (an
/// idle-killing proxy stays reachable meanwhile).
fn keep_alive(pool: &Arc<Pool>, every: Duration) {
    let pool = Arc::downgrade(pool);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(pool) = pool.upgrade().filter(|pool| !pool.is_closed()) else { break };
            if let Err(error) = pool.rows(pool.ping_sql(), 1).await {
                log::debug!("keep-alive: {}", error.message);
            }
        }
    });
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

impl DbManager {
    /// `data_dir` is `<data dir>/db`; its files are created on first write.
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            secrets: SecretStore::new(paths::secrets(&data_dir)),
            history: Arc::new(HistoryStore::new(paths::history(&data_dir))),
            data_dir,
            root: Mutex::new(None),
            pools: Mutex::new(HashMap::new()),
            session_passwords: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Sets the open project (`None` when no project is open).
    pub fn set_root(&self, root: Option<String>) {
        *self.root.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = root;
    }

    fn root(&self) -> Option<String> {
        self.root.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// The project's data sources, then the global ones (a project one wins on
    /// the same id).
    pub fn sources(&self) -> DbResult<Vec<DataSource>> {
        let mut all = match self.root() {
            Some(root) => source::load(&paths::project_sources(&self.data_dir, &root))?,
            None => Vec::new(),
        };
        let global: Vec<_> = self
            .global_sources()
            .into_iter()
            .filter(|global| all.iter().all(|source| source.id != global.id))
            .collect();
        all.extend(global);
        Ok(all)
    }

    fn global_sources(&self) -> Vec<DataSource> {
        let mut sources = source::load(&paths::global_sources(&self.data_dir)).unwrap_or_else(|error| {
            log::warn!("global data sources: {}", error.message);
            Vec::new()
        });
        for source in &mut sources {
            source.global = true;
        }
        sources
    }

    /// The connection settings of target `target` ([`DataSource::resolved`]),
    /// with its database for `<id>:<database>`.
    pub fn source(&self, target: &str) -> DbResult<DataSource> {
        let (id, database) = split_target(target);
        let found = self
            .sources()?
            .into_iter()
            .find(|source| source.id == id)
            .ok_or_else(|| DbError::not_found(format!("No data source {id}")))?;
        let mut source = found.resolved()?;
        if let Some(database) = database {
            source.database = database.to_owned();
        }
        Ok(source)
    }

    /// Saves the data source list; connections of removed or changed sources
    /// are closed. Global ones go to the app-wide list, the others to the
    /// project's (which needs an open project).
    pub async fn save_sources(&self, sources: Vec<DataSource>) -> DbResult<()> {
        let old = self.sources().unwrap_or_default();
        let (global, project): (Vec<_>, Vec<_>) = sources.iter().cloned().partition(|source| source.global);
        source::save(&paths::global_sources(&self.data_dir), &global)?;
        match self.root() {
            Some(root) => source::save(&paths::project_sources(&self.data_dir, &root), &project)?,
            None if project.is_empty() => {}
            None => return Err(DbError::invalid("Project data sources need an open project")),
        }
        for previous in old {
            match sources.iter().find(|source| source.id == previous.id) {
                Some(source) if *source == previous => {}
                _ => {
                    self.session_passwords
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&previous.id);
                    if sources.iter().all(|source| source.id != previous.id) {
                        let _ = self.secrets.remove(&previous.id);
                    }
                    self.disconnect_source(&previous.id).await;
                }
            }
        }
        Ok(())
    }

    /// Remembers `password` for the session, and in the saved passwords when
    /// `save` is set (`None` forgets it).
    ///
    /// A save that fails does not fail the call: the session copy still works,
    /// and the user is asked again next time.
    pub fn set_password(&self, id: &str, password: Option<String>, save: bool) -> DbResult<()> {
        {
            let mut passwords = self.session_passwords.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match &password {
                Some(password) => passwords.insert(id.to_owned(), password.clone()),
                None => passwords.remove(id),
            };
        }
        let saved = match (&password, save) {
            (Some(password), true) => self.secrets.set(id, password),
            _ => self.secrets.remove(id),
        };
        if let Err(error) = saved {
            log::warn!("could not save the password: {}", error.message);
        }
        Ok(())
    }

    fn password(&self, source: &DataSource) -> Option<String> {
        if let Some(password) = self
            .session_passwords
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&source.id)
        {
            return Some(password.clone());
        }
        if source.driver != DbDriver::Sqlite && source.save_password {
            if let Ok(Some(password)) = self.secrets.get(&source.id) {
                return Some(password);
            }
        }
        source.url_password()
    }

    /// Connects with `source` as given (not necessarily saved): Test Connection.
    pub async fn test(&self, source: &DataSource, password: Option<String>) -> DbResult<String> {
        let source = &source.resolved()?;
        let password = match password {
            Some(password) => Some(password),
            None => self.password(source),
        };
        let pool = Pool::connect(source, password.as_deref(), self.root_path().as_deref()).await?;
        let result = pool.rows(version_query(source.driver), 1).await;
        pool.close().await;
        let version = result?
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().next().flatten());
        Ok(version.unwrap_or_else(|| "Connected".into()))
    }

    fn root_path(&self) -> Option<PathBuf> {
        self.root().map(PathBuf::from)
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.pools.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains_key(id)
    }

    /// Connected targets (data source ids, `<id>:<database>`).
    pub fn connected(&self) -> Vec<String> {
        self.pools
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    /// The pool of target `id`, connecting first if needed.
    pub async fn pool(&self, id: &str) -> DbResult<Arc<Pool>> {
        if let Some(pool) = self.pools.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(id) {
            return Ok(pool.clone());
        }
        let source = self.source(id)?;
        let password = self.password(&source);
        let pool = Arc::new(Pool::connect(&source, password.as_deref(), self.root_path().as_deref()).await?);
        // Another caller may have connected meanwhile; keep theirs.
        let kept = self
            .pools
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(id.to_owned())
            .or_insert_with(|| pool.clone())
            .clone();
        if Arc::ptr_eq(&kept, &pool) {
            if let Some(secs) = source.options.keep_alive_secs.filter(|secs| *secs > 0) {
                keep_alive(&pool, Duration::from_secs(secs.into()));
            }
        }
        Ok(kept)
    }

    /// Disconnects target `id` (one database of a data source).
    pub async fn disconnect(&self, id: &str) {
        // A held connection would keep the pool from closing; manual mode stays on.
        let session = self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(id).cloned();
        if let Some(session) = session {
            end_session(&session).await;
        }
        let pool = self.pools.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(id);
        if let Some(pool) = pool {
            pool.close().await;
        }
    }

    /// Disconnects every database of data source `id`.
    pub async fn disconnect_source(&self, id: &str) {
        let targets: Vec<String> =
            self.connected().into_iter().filter(|target| split_target(target).0 == id).collect();
        for target in targets {
            self.disconnect(&target).await;
        }
    }

    /// The databases of the server of data source `id` (PostgreSQL), the
    /// connected one first. Other drivers list their schemas directly.
    pub async fn databases(&self, id: &str) -> DbResult<Databases> {
        let id = split_target(id).0;
        let introspection = self.source(id)?.introspection;
        let pool = self.pool(id).await?;
        if pool.driver() != DbDriver::Postgres {
            return Err(DbError::invalid("only PostgreSQL data sources list databases"));
        }
        let first = |rows: Vec<Vec<Option<String>>>| -> Vec<String> {
            rows.into_iter().filter_map(|row| row.into_iter().next().flatten()).collect()
        };
        let current = first(pool.rows("SELECT current_database()", 1).await?).into_iter().next().unwrap_or_default();
        let rows = pool.rows(sql::databases(introspection.show_templates), MAX_META_ROWS).await?;
        let mut names: Vec<String> = first(rows)
            .into_iter()
            .filter(|name| {
                introspection.show_system
                    || *name == current
                    || !sql::INTERNAL_DATABASES.contains(&name.as_str())
            })
            .collect();
        if !names.contains(&current) {
            names.insert(0, current.clone());
        }
        Ok(Databases { current, names })
    }

    /// Every schema of target `id`; system schemas only with the data source's
    /// `introspection.show_system`.
    pub async fn schemas(&self, id: &str) -> DbResult<Vec<String>> {
        let system = self.source(id)?.introspection.show_system;
        let pool = self.pool(id).await?;
        let rows = pool.rows(sql::schemas(pool.driver(), system), MAX_META_ROWS).await?;
        Ok(rows.into_iter().filter_map(|row| row.into_iter().next().flatten()).collect())
    }

    /// The tables and views of `schema`.
    pub async fn tables(&self, id: &str, schema: &str) -> DbResult<Vec<TableInfo>> {
        let pool = self.pool(id).await?;
        let rows = pool.rows(&sql::tables(pool.driver(), schema), MAX_META_ROWS).await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let mut cells = row.into_iter();
                let name = cells.next().flatten()?;
                Some(TableInfo { name, kind: DbTableKind::from_catalog(cells.next().flatten().as_deref()) })
            })
            .collect())
    }

    /// Columns, indexes, foreign keys and triggers of `table`.
    pub async fn table_details(&self, id: &str, schema: &str, table: &str) -> DbResult<TableDetails> {
        let pool = self.pool(id).await?;
        let driver = pool.driver();
        let columns = pool
            .rows(&sql::columns(driver, schema, table), MAX_META_ROWS)
            .await?
            .into_iter()
            .filter_map(|row| {
                let mut cells = row.into_iter();
                let name = cells.next().flatten()?;
                let data_type = cells.next().flatten().unwrap_or_default();
                let nullable = objects::flag(&cells.next().flatten());
                let default = cells.next().flatten();
                let primary_key = objects::flag(&cells.next().flatten());
                Some(ColumnInfo { name, data_type, nullable, default, primary_key })
            })
            .collect();
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for row in pool.rows(&sql::indexes(driver, schema, table), MAX_META_ROWS).await? {
            let mut cells = row.into_iter();
            let (Some(name), unique, Some(column)) =
                (cells.next().flatten(), cells.next().flatten(), cells.next().flatten())
            else {
                continue;
            };
            match indexes.last_mut() {
                Some(last) if last.name == name => last.columns.push(column),
                _ => indexes.push(IndexInfo { name, unique: objects::flag(&unique), columns: vec![column] }),
            }
        }
        // A bad foreign-key catalog must not hide the columns.
        let fk_rows = pool
            .rows(&sql::table_foreign_keys(driver, schema, table), MAX_META_ROWS)
            .await
            .unwrap_or_default();
        let mut foreign_keys = objects::group_foreign_keys(fk_rows);
        // SQLite keys that reference the primary key implicitly: look it up.
        for key in foreign_keys.iter_mut().filter(|key| key.ref_columns.is_empty()) {
            key.ref_columns = pool
                .rows(&sql::columns(driver, &key.ref_schema, &key.ref_table), MAX_META_ROWS)
                .await?
                .into_iter()
                .filter(|row| objects::flag(&row.get(4).cloned().flatten()))
                .filter_map(|row| row.into_iter().next().flatten())
                .collect();
        }
        foreign_keys.retain(|key| key.columns.len() == key.ref_columns.len());
        let trigger_rows = pool.rows(&sql::triggers(driver, schema, table), MAX_META_ROWS).await.unwrap_or_else(|error| {
            log::warn!("triggers: {}", error.message);
            Vec::new()
        });
        let triggers = trigger_rows
            .into_iter()
            .filter_map(|row| {
                let mut cells = row.into_iter();
                let name = cells.next().flatten()?;
                let (timing, events) = if driver == DbDriver::Sqlite {
                    sql::sqlite_trigger_event(&cells.next().flatten().unwrap_or_default())
                } else {
                    (cells.next().flatten().unwrap_or_default(), cells.next().flatten().unwrap_or_default())
                };
                Some(TriggerInfo { name, timing, events })
            })
            .collect();
        Ok(TableDetails { columns, indexes, foreign_keys, triggers })
    }

    /// The routines and sequences of `schema` (empty where the driver has none).
    pub async fn schema_objects(&self, id: &str, schema: &str) -> DbResult<SchemaObjects> {
        let pool = self.pool(id).await?;
        let driver = pool.driver();
        let mut out = SchemaObjects::default();
        if let Some(query) = sql::routines(driver, schema) {
            out.routines = pool
                .rows(&query, MAX_META_ROWS)
                .await?
                .into_iter()
                .filter_map(|row| {
                    let mut cells = row.into_iter();
                    let name = cells.next().flatten()?;
                    let kind = if cells.next().flatten().as_deref() == Some("procedure") {
                        DbObjectKind::Procedure
                    } else {
                        DbObjectKind::Function
                    };
                    let arguments = cells.next().flatten().unwrap_or_default();
                    let returns = cells
                        .next()
                        .flatten()
                        .filter(|result| !result.is_empty() && kind == DbObjectKind::Function);
                    Some(RoutineInfo { name, kind, arguments, returns })
                })
                .collect();
        }
        if let Some(query) = sql::sequences(driver, schema) {
            out.sequences = pool
                .rows(&query, MAX_META_ROWS)
                .await?
                .into_iter()
                .filter_map(|row| {
                    let mut cells = row.into_iter();
                    Some(SequenceInfo {
                        name: cells.next().flatten()?,
                        data_type: cells.next().flatten().unwrap_or_default(),
                    })
                })
                .collect();
        }
        Ok(out)
    }

    /// Runs `statement` on `id` (in its open transaction in manual-commit mode),
    /// recording it in the data source's query history.
    pub async fn execute(
        &self,
        id: &str,
        statement: &str,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> DbResult<QueryResult> {
        self.execute_from(id, statement, 0, max_rows, cancel).await
    }

    /// [`execute`](Self::execute), reading past the first `skip` rows without
    /// keeping them: a later page of a result, where only that page is decoded.
    pub async fn execute_from(
        &self,
        id: &str,
        statement: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> DbResult<QueryResult> {
        let result = self.run(id, statement, skip, max_rows, cancel).await;
        let ran = match &result {
            Ok(_) => true,
            Err(error) => !error.is_cancelled(),
        };
        if ran {
            let source = split_target(id).0.to_owned();
            if let Err(error) = self.history.add(&source, statement, now_ms()) {
                log::warn!("query history: {}", error.message);
            }
        }
        result
    }

    /// The query history of data source `id`, newest first.
    pub async fn history(&self, id: &str) -> DbResult<Vec<HistoryEntry>> {
        let (history, source) = (self.history.clone(), split_target(id).0.to_owned());
        tokio::task::spawn_blocking(move || history.list(&source))
            .await
            .map_err(|error| DbError::internal(error.to_string()))
    }

    /// Forgets statements of the query history of `id` (all of them for `None`).
    pub async fn remove_history(&self, id: &str, texts: Option<Vec<String>>) -> DbResult<()> {
        let (history, source) = (self.history.clone(), split_target(id).0.to_owned());
        tokio::task::spawn_blocking(move || history.remove(&source, texts.as_deref()))
            .await
            .map_err(|error| DbError::internal(error.to_string()))?
    }

    async fn run(
        &self,
        id: &str,
        statement: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> DbResult<QueryResult> {
        let pool = self.pool(id).await?;
        let session = self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(id).cloned();
        let Some(session) = session else {
            return pool.execute_from(statement, skip, max_rows, cancel).await;
        };
        let mut held = session.lock().await;
        if held.is_none() {
            let mut connection = Held::acquire(&pool).await?;
            connection.command(conn::begin_statement(pool.driver())).await?;
            *held = Some(connection);
        }
        let connection = held.as_mut().expect("opened above");
        let result = connection.execute_from(&pool, statement, skip, max_rows, cancel).await;
        if cancel.is_cancelled() {
            // The server rolls the transaction back with the connection.
            held.take().expect("opened above").discard().await;
            return Err(DbError::cancelled());
        }
        result
    }

    /// Switches `id` between auto-commit and manual commit. Leaving manual mode
    /// rolls back what was not committed.
    pub async fn set_manual_commit(&self, id: &str, manual: bool) -> DbResult<()> {
        if manual {
            self.source(id)?;
            self.sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entry(id.to_owned())
                .or_default();
        } else {
            let session = self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(id);
            if let Some(session) = session {
                end_session(&session).await;
            }
        }
        Ok(())
    }

    /// Commits (or rolls back) the open transaction of a manual-commit target.
    pub async fn finish_transaction(&self, id: &str, commit: bool) -> DbResult<()> {
        let session = self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(id).cloned();
        let Some(session) = session else { return Ok(()) };
        let mut held = session.lock().await;
        let Some(mut connection) = held.take() else { return Ok(()) };
        match connection.command(if commit { "COMMIT" } else { "ROLLBACK" }).await {
            Ok(()) => Ok(()),
            Err(error) => {
                connection.discard().await;
                Err(error)
            }
        }
    }

    /// One page of `schema.table`, ordered and filtered on the server.
    pub async fn table_page(
        &self,
        _id: &str,
        _schema: &str,
        _table: &str,
        _filter: Option<&str>,
        _sort: &[SortKey],
        _offset: u64,
        _limit: u64,
        _cancel: &CancellationToken,
    ) -> DbResult<TablePage> {
        Err(DbError::internal("not implemented"))
    }

    /// Applies the edits in one transaction and returns the number of rows
    /// changed. Any failure rolls the whole batch back.
    pub async fn apply_edits(
        &self,
        _id: &str,
        _schema: &str,
        _table: &str,
        _edits: &[DbRowEdit],
    ) -> DbResult<f64> {
        Err(DbError::internal("not implemented"))
    }

    /// The `CREATE TABLE` statement of `schema.name`.
    pub async fn ddl(&self, _id: &str, _schema: &str, _name: &str) -> DbResult<String> {
        Err(DbError::internal("not implemented"))
    }

    /// The definition of a routine, trigger or sequence.
    pub async fn object_ddl(
        &self,
        _id: &str,
        _schema: &str,
        _kind: DbObjectKind,
        _name: &str,
    ) -> DbResult<String> {
        Err(DbError::internal("not implemented"))
    }

    /// The tables, columns and foreign keys the editor completes names from.
    pub async fn completion(&self, _id: &str) -> DbResult<CompletionModel> {
        Err(DbError::internal("not implemented"))
    }

    /// Runs `statements` in order, stopping at the first error. Errors are
    /// reported per statement; only cancellation fails the whole call.
    pub async fn execute_all(
        &self,
        _id: &str,
        _statements: &[SqlStatement],
        _skip: usize,
        _max_rows: usize,
        _cancel: &CancellationToken,
    ) -> DbResult<Vec<StatementOutcome>> {
        Err(DbError::internal("not implemented"))
    }
}

/// The statement Test Connection runs to show what it reached.
fn version_query(driver: DbDriver) -> &'static str {
    match driver {
        DbDriver::Sqlite => "SELECT 'SQLite ' || sqlite_version()",
        DbDriver::Postgres => "SELECT version()",
        DbDriver::Mysql => "SELECT CONCAT(@@version_comment, ' ', VERSION())",
        DbDriver::SqlServer | DbDriver::Clickhouse | DbDriver::Oracle => "SELECT 1",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn manager(dir: &Path) -> DbManager {
        DbManager::new(dir.join("db"))
    }

    fn source(id: &str, global: bool) -> DataSource {
        DataSource {
            id: id.into(),
            name: id.into(),
            driver: DbDriver::Postgres,
            save_password: true,
            global,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn lists_global_sources_next_to_the_project_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let db = manager(tmp.path());
        db.set_root(Some("C:\\work\\app".into()));
        db.save_sources(vec![source("local", false), source("shared", true)]).await.unwrap();
        assert_eq!(
            db.sources().unwrap().into_iter().map(|source| (source.id, source.global)).collect::<Vec<_>>(),
            [("local".into(), false), ("shared".into(), true)]
        );
        // Another project sees only the global one, without opening a connection.
        let other = manager(tmp.path());
        other.set_root(Some("D:\\work\\other".into()));
        assert_eq!(
            other.sources().unwrap().into_iter().map(|source| source.id).collect::<Vec<_>>(),
            ["shared"]
        );
        // The global file never records the flag: it is implied by where it lives.
        let global = std::fs::read_to_string(paths::global_sources(&tmp.path().join("db"))).unwrap();
        assert!(!global.contains("global"), "{global}");
        assert!(!std::fs::read_to_string(paths::project_sources(&tmp.path().join("db"), "C:\\work\\app"))
            .unwrap()
            .contains("shared"));
    }

    #[tokio::test]
    async fn project_sources_need_an_open_project() {
        let tmp = tempfile::tempdir().unwrap();
        let db = manager(tmp.path());
        assert!(db.save_sources(vec![source("local", false)]).await.is_err());
        db.save_sources(vec![source("shared", true)]).await.unwrap();
        assert_eq!(db.sources().unwrap().len(), 1);
    }

    #[test]
    fn a_password_can_be_session_only_or_saved() {
        let tmp = tempfile::tempdir().unwrap();
        let db = manager(tmp.path());
        let source = source("s", false);
        db.set_password("s", Some("session-only".into()), false).unwrap();
        assert_eq!(db.password(&source).as_deref(), Some("session-only"));
        // Saved for later sessions, and never written anywhere but the secrets file.
        db.set_password("s", Some("saved".into()), true).unwrap();
        let reopened = manager(tmp.path());
        assert_eq!(reopened.password(&source).as_deref(), Some("saved"));
        // Forgetting it drops the saved copy as well.
        reopened.set_password("s", None, true).unwrap();
        assert_eq!(manager(tmp.path()).password(&source), None);
    }

    #[tokio::test]
    async fn saving_a_source_that_disappeared_forgets_its_password() {
        let tmp = tempfile::tempdir().unwrap();
        let db = manager(tmp.path());
        db.set_root(Some("C:\\work\\app".into()));
        db.save_sources(vec![source("gone", false)]).await.unwrap();
        db.set_password("gone", Some("pw".into()), true).unwrap();
        db.save_sources(Vec::new()).await.unwrap();
        assert_eq!(db.sources().unwrap(), Vec::new());
        assert_eq!(db.password(&source("gone", false)), None);
    }

    #[test]
    fn splits_targets_into_a_source_and_a_database() {
        assert_eq!(split_target("a1"), ("a1", None));
        assert_eq!(split_target("a1:shop"), ("a1", Some("shop")));
        assert_eq!(split_target("a1:"), ("a1", None));
    }

    #[tokio::test]
    async fn reads_url_only_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let db = manager(tmp.path());
        db.set_root(Some("C:\\work\\app".into()));
        db.save_sources(vec![DataSource {
            id: "url".into(),
            name: "url".into(),
            driver: DbDriver::Postgres,
            url_only: true,
            url: "postgres://ann:pw@db.local:6543/app".into(),
            ..Default::default()
        }])
        .await
        .unwrap();
        let source = db.source("url:other").unwrap();
        assert_eq!((source.host.as_str(), source.database.as_str()), ("db.local", "other"));
        assert_eq!(db.password(&source).as_deref(), Some("pw"));
    }
}
