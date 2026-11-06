//! Live connections (one small pool per data source) and statement execution.
//!
//! Ported from `ide_db::conn` of the reference project (Apache-2.0), keeping the
//! SQLite, PostgreSQL and MySQL paths. The SQL Server, ClickHouse and Oracle
//! paths, the SSH tunnel and `specta::Type` are gone; a data source on one of
//! those drivers is rejected with [`DbError`] until the driver is ported.
//!
//! Statements run through `raw_sql` (PostgreSQL's simple query protocol,
//! MySQL's text protocol), so every value arrives as text and is shown as is,
//! whatever its type.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{
    Column, ColumnIndex, Connection, Decode, Executor, MySql, Postgres, Row, SqlSafeStr, Sqlite, TypeInfo, ValueRef,
    mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode},
    pool::PoolConnection,
    postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode},
    sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions},
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use crate::error::{DbError, DbErrorCode, DbResult};
use crate::source::{DataSource, DbDriver, DbSslMode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub statement: String,
    pub columns: Vec<ResultColumn>,
    /// Cell text; `None` is SQL NULL. Binary values are `0x…` hex.
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows changed by a DML statement (`None` for queries).
    pub affected: Option<f64>,
    /// More rows exist beyond the limit.
    pub has_more: bool,
    pub elapsed_ms: f64,
    /// Until the server's first answer; the rest of `elapsed_ms` is fetching.
    pub execution_ms: f64,
}

pub enum Pool {
    Sqlite(SqlitePool),
    Postgres(PgPool),
    Mysql(MySqlPool),
}

/// Runs `$body` with `$p` bound to the concrete pool of each driver.
macro_rules! with_pool {
    ($pool:expr, $p:ident => $body:expr) => {
        match $pool {
            Pool::Sqlite($p) => $body,
            Pool::Postgres($p) => $body,
            Pool::Mysql($p) => $body,
        }
    };
}

pub(crate) fn db_err(error: sqlx::Error) -> DbError {
    match &error {
        sqlx::Error::Database(database) => {
            let code = database.code().map(|code| code.into_owned());
            // Wrong password: PostgreSQL 28P01, MySQL 1045 (SQLSTATE 28000).
            let auth = matches!(code.as_deref(), Some("28P01" | "28000" | "1045"));
            let message = match code {
                Some(code) => format!("[{code}] {}", database.message()),
                None => database.message().to_owned(),
            };
            DbError::new(if auth { DbErrorCode::AuthFailed } else { DbErrorCode::Invalid }, message)
        }
        sqlx::Error::PoolTimedOut => DbError::unreachable("Timed out connecting to the database"),
        sqlx::Error::Io(_) | sqlx::Error::Tls(_) => DbError::unreachable(error.to_string()),
        sqlx::Error::Configuration(_) => DbError::invalid(error.to_string()),
        _ => DbError::protocol(error.to_string()),
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("0x");
    for byte in bytes {
        text.push_str(&format!("{byte:02X}"));
    }
    text
}

/// How [`cell`] shows a value whose bytes are not text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cells {
    /// Result grids: binary values as `0x…` hex.
    Display,
    /// Catalog queries: names and definitions, so bytes are read as UTF-8 whatever the
    /// column's type (MySQL flags `utf8mb3_bin` catalog columns BINARY, and sends every
    /// column as binary under `character_set_results = binary`).
    Text,
}

/// Whether a value of type `ty` is binary data (see [`binary_type`]).
fn is_binary<DB: sqlx::Database>(ty: &DB::TypeInfo) -> bool
where
    String: sqlx::Type<DB>,
{
    binary_type(ty.name(), <String as sqlx::Type<DB>>::compatible(ty))
}

/// A BLOB / BINARY type that the driver does not read as text: MySQL flags text in a
/// binary collation (`utf8mb4_bin`) BINARY too, and only the `binary` collation is bytes.
fn binary_type(name: &str, text: bool) -> bool {
    let name = name.to_ascii_uppercase();
    (name.contains("BLOB") || name.contains("BINARY")) && !text
}

/// Bytes as text: UTF-8, else hex (grids) or with invalid sequences replaced (catalog names).
fn bytes_text(bytes: Vec<u8>, mode: Cells) -> String {
    match (String::from_utf8(bytes), mode) {
        (Ok(text), _) => text,
        (Err(error), Cells::Display) => hex(error.as_bytes()),
        (Err(error), Cells::Text) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    }
}

/// The text of column `i` of `row`.
fn cell<R: Row>(row: &R, i: usize, mode: Cells) -> Option<String>
where
    usize: ColumnIndex<R>,
    String: sqlx::Type<R::Database>,
    for<'r> String: Decode<'r, R::Database>,
    for<'r> Vec<u8>: Decode<'r, R::Database>,
{
    let raw = row.try_get_raw(i).ok()?;
    if raw.is_null() {
        return None;
    }
    if mode == Cells::Display && is_binary::<R::Database>(&raw.type_info()) {
        return <Vec<u8> as Decode<R::Database>>::decode(raw).ok().map(|bytes| hex(&bytes));
    }
    match <String as Decode<R::Database>>::decode(raw) {
        Ok(text) => Some(text),
        Err(_) => {
            let raw = row.try_get_raw(i).ok()?;
            <Vec<u8> as Decode<R::Database>>::decode(raw).ok().map(|bytes| bytes_text(bytes, mode))
        }
    }
}

fn result_columns<R: Row>(row: &R) -> Vec<ResultColumn> {
    row.columns()
        .iter()
        .map(|column| ResultColumn {
            name: column.name().to_owned(),
            type_name: column.type_info().name().to_owned(),
        })
        .collect()
}

/// Streams the results of `$sql` on executor `$exec`, reading past the first `$skip`
/// rows without decoding them, then keeping at most `$max` rows with their cells read as `$mode`.
macro_rules! fetch {
    ($exec:expr, $sql:expr, $max:expr, $mode:expr) => {
        fetch!($exec, $sql, 0usize, $max, $mode)
    };
    ($exec:expr, $sql:expr, $skip:expr, $max:expr, $mode:expr) => {{
        let mut stream = sqlx::raw_sql(sqlx::AssertSqlSafe($sql.to_owned())).fetch_many($exec);
        let mut columns: Vec<ResultColumn> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut affected: Option<u64> = None;
        let mut has_more = false;
        let mut failure = None;
        let mut first: Option<Instant> = None;
        let mut to_skip: usize = $skip;
        while let Some(item) = stream.next().await {
            first.get_or_insert_with(Instant::now);
            match item {
                Ok(sqlx::Either::Left(done)) => affected = Some(affected.unwrap_or(0) + done.rows_affected()),
                Ok(sqlx::Either::Right(row)) => {
                    if columns.is_empty() {
                        columns = result_columns(&row);
                    }
                    if to_skip > 0 {
                        to_skip -= 1;
                        continue;
                    }
                    if rows.len() >= $max {
                        has_more = true;
                        break;
                    }
                    rows.push((0..row.len()).map(|i| cell(&row, i, $mode)).collect());
                }
                Err(error) => {
                    failure = Some(db_err(error));
                    break;
                }
            }
        }
        drop(stream);
        match failure {
            Some(error) => Err(error),
            None => Ok((columns, rows, affected, has_more, first)),
        }
    }};
}

/// Columns, rows, rows affected, more rows beyond the limit, time of the first answer.
pub(crate) type Fetched = (Vec<ResultColumn>, Vec<Vec<Option<String>>>, Option<u64>, bool, Option<Instant>);

/// The server-side id of a connection (to cancel its statement from another one).
macro_rules! backend_id {
    ($conn:expr, $sql:expr) => {{
        let fetched: DbResult<Fetched> = fetch!($conn, $sql, 1, Cells::Text);
        fetched
            .ok()
            .and_then(|fetched| fetched.1.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten())
            .filter(|id| id.chars().all(|c| c.is_ascii_digit()))
    }};
}

fn looks_like_query(sql: &str) -> bool {
    let first = sql
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("--"))
        .and_then(|line| line.split_whitespace().next())
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(
        first.as_str(),
        "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "PRAGMA" | "EXPLAIN" | "DESCRIBE" | "DESC"
    )
}

/// A path setting of the SSL fields, with `~/` expanded.
fn file_setting(path: &str) -> Option<PathBuf> {
    let path = path.trim();
    (!path.is_empty()).then(|| expand(path))
}

fn expand(path: &str) -> PathBuf {
    let rest = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"));
    match (rest, home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|home| !home.as_os_str().is_empty())
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// A MySQL `SET` value: numbers and keywords as they are, anything else quoted.
fn mysql_value(value: &str) -> String {
    let keyword = ["ON", "OFF", "TRUE", "FALSE", "DEFAULT"]
        .iter()
        .any(|keyword| keyword.eq_ignore_ascii_case(value));
    if keyword || value.parse::<f64>().is_ok() {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
    }
}

/// How the Options and Advanced tabs reach a connection.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Setup {
    /// PostgreSQL run-time parameters (startup `options`), SQLite pragmas.
    pub params: Vec<(String, String)>,
    /// Run on every new connection: MySQL session settings, then the startup script.
    pub statements: Vec<String>,
    pub application_name: Option<String>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub statement_cache: Option<usize>,
    pub connect_timeout: Option<Duration>,
}

impl Setup {
    pub fn of(source: &DataSource) -> DbResult<Self> {
        let mut setup = Setup::default();
        let options = &source.options;
        match source.driver {
            DbDriver::Postgres => {
                if source.read_only {
                    setup.params.push(("default_transaction_read_only".into(), "on".into()));
                }
                if !options.default_schema.trim().is_empty() {
                    setup.params.push(("search_path".into(), options.default_schema.trim().into()));
                }
                if !options.time_zone.trim().is_empty() {
                    setup.params.push(("TimeZone".into(), options.time_zone.trim().into()));
                }
            }
            DbDriver::Mysql if source.read_only => setup.statements.push("SET SESSION TRANSACTION READ ONLY".into()),
            _ => {}
        }
        for property in &source.properties {
            let value = property.value.trim();
            let name = property.name.trim().replace('-', "_");
            if name.is_empty() {
                continue;
            }
            if !is_identifier(&name) {
                return Err(DbError::invalid(format!(
                    "Invalid driver property name: {}",
                    property.name.trim()
                )));
            }
            let number = |what: &str| {
                value
                    .parse::<u64>()
                    .map_err(|_| DbError::invalid(format!("{what} must be a whole number: {value}")))
            };
            match (source.driver, name.to_ascii_lowercase().as_str()) {
                (_, "statement_cache_capacity") => setup.statement_cache = Some(number(&name)? as usize),
                (_, "connect_timeout") => setup.connect_timeout = Some(Duration::from_secs(number(&name)?)),
                (DbDriver::Postgres, "application_name") => setup.application_name = Some(value.to_owned()),
                (DbDriver::Mysql, "charset") => setup.charset = Some(value.to_owned()),
                (DbDriver::Mysql, "collation") => setup.collation = Some(value.to_owned()),
                (DbDriver::Mysql, _) => setup.statements.push(format!("SET SESSION {name} = {}", mysql_value(value))),
                _ => setup.params.push((name, value.to_owned())),
            }
        }
        let script = options.startup_script.trim();
        if !script.is_empty() {
            setup.statements.extend(crate::split::split(script, source.driver).into_iter().map(|statement| statement.text));
        }
        Ok(setup)
    }
}

impl Pool {
    pub fn driver(&self) -> DbDriver {
        match self {
            Pool::Sqlite(_) => DbDriver::Sqlite,
            Pool::Postgres(_) => DbDriver::Postgres,
            Pool::Mysql(_) => DbDriver::Mysql,
        }
    }

    /// The keep-alive ping.
    pub fn ping_sql(&self) -> &'static str {
        "SELECT 1"
    }

    /// Opens a pool and one connection (so bad settings fail here).
    pub async fn connect(source: &DataSource, password: Option<&str>, root: Option<&Path>) -> DbResult<Self> {
        const MAX: u32 = 4;
        let setup = Setup::of(source)?;
        let timeout = setup.connect_timeout.unwrap_or(Duration::from_secs(30));
        let init = Arc::new(setup.statements);
        // Runs the session statements (startup script…) on every new connection.
        macro_rules! after_connect {
            () => {{
                let init = init.clone();
                move |conn, _| {
                    let init = init.clone();
                    Box::pin(async move {
                        for sql in init.iter() {
                            sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone())).execute(&mut *conn).await?;
                        }
                        Ok(())
                    })
                }
            }};
        }
        match source.driver {
            DbDriver::Sqlite => {
                let file = source.file.as_deref().ok_or_else(|| DbError::invalid("No database file"))?;
                let file = Path::new(file);
                let file = match root {
                    Some(root) if file.is_relative() => root.join(file),
                    _ => file.to_path_buf(),
                };
                let mut options =
                    SqliteConnectOptions::new().filename(&file).create_if_missing(false).read_only(source.read_only);
                for (key, value) in setup.params {
                    options = options.pragma(key, value);
                }
                if let Some(capacity) = setup.statement_cache {
                    options = options.statement_cache_capacity(capacity);
                }
                let pool = SqlitePoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .after_connect(after_connect!())
                    .connect_with(options)
                    .await
                    .map_err(db_err)?;
                Ok(Pool::Sqlite(pool))
            }
            DbDriver::Postgres => {
                let mut options = PgConnectOptions::new()
                    .host(&source.host)
                    .port(source.port.unwrap_or(5432))
                    .username(&source.user)
                    .application_name(setup.application_name.as_deref().unwrap_or("WingHarness"))
                    .ssl_mode(match source.ssl {
                        DbSslMode::Disable => PgSslMode::Disable,
                        DbSslMode::Prefer => PgSslMode::Prefer,
                        DbSslMode::Require => PgSslMode::Require,
                        DbSslMode::VerifyCa => PgSslMode::VerifyCa,
                        DbSslMode::VerifyFull => PgSslMode::VerifyFull,
                    });
                if let Some(file) = file_setting(&source.ssl_ca_file) {
                    options = options.ssl_root_cert(file);
                }
                if let Some(file) = file_setting(&source.ssl_cert_file) {
                    options = options.ssl_client_cert(file);
                }
                if let Some(file) = file_setting(&source.ssl_key_file) {
                    options = options.ssl_client_key(file);
                }
                if !source.database.is_empty() {
                    options = options.database(&source.database);
                }
                if let Some(password) = password {
                    options = options.password(password);
                }
                if !setup.params.is_empty() {
                    options = options.options(setup.params);
                }
                if let Some(capacity) = setup.statement_cache {
                    options = options.statement_cache_capacity(capacity);
                }
                let pool = PgPoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .after_connect(after_connect!())
                    .connect_with(options)
                    .await
                    .map_err(db_err)?;
                Ok(Pool::Postgres(pool))
            }
            DbDriver::Mysql => {
                let mut options = MySqlConnectOptions::new()
                    .host(&source.host)
                    .port(source.port.unwrap_or(3306))
                    .username(&source.user)
                    .ssl_mode(match source.ssl {
                        DbSslMode::Disable => MySqlSslMode::Disabled,
                        DbSslMode::Prefer => MySqlSslMode::Preferred,
                        DbSslMode::Require => MySqlSslMode::Required,
                        DbSslMode::VerifyCa => MySqlSslMode::VerifyCa,
                        DbSslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
                    });
                if let Some(file) = file_setting(&source.ssl_ca_file) {
                    options = options.ssl_ca(file);
                }
                if let Some(file) = file_setting(&source.ssl_cert_file) {
                    options = options.ssl_client_cert(file);
                }
                if let Some(file) = file_setting(&source.ssl_key_file) {
                    options = options.ssl_client_key(file);
                }
                if !source.database.is_empty() {
                    options = options.database(&source.database);
                }
                if let Some(password) = password {
                    options = options.password(password);
                }
                if let Some(charset) = &setup.charset {
                    options = options.charset(charset);
                }
                if let Some(collation) = &setup.collation {
                    options = options.collation(collation);
                }
                if let Some(capacity) = setup.statement_cache {
                    options = options.statement_cache_capacity(capacity);
                }
                let time_zone = source.options.time_zone.trim();
                if !time_zone.is_empty() {
                    options = options.timezone(Some(time_zone.to_owned()));
                }
                let pool = MySqlPoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .after_connect(after_connect!())
                    .connect_with(options)
                    .await
                    .map_err(db_err)?;
                Ok(Pool::Mysql(pool))
            }
            driver => Err(DbError::invalid(format!("{driver:?} data sources are not supported yet"))),
        }
    }

    pub async fn close(&self) {
        with_pool!(self, pool => pool.close().await)
    }

    pub fn is_closed(&self) -> bool {
        with_pool!(self, pool => pool.is_closed())
    }

    /// Runs `sql` (no row limit beyond `max`), for introspection: cells are text (see [`Cells::Text`]).
    pub async fn rows(&self, sql: &str, max: usize) -> DbResult<Vec<Vec<Option<String>>>> {
        let fetched: DbResult<Fetched> = with_pool!(self, pool => fetch!(pool, sql, max, Cells::Text));
        Ok(fetched?.1)
    }

    /// Runs one statement and keeps at most `max_rows` rows. Cancelling stops
    /// the statement on the server (PostgreSQL, MySQL) and drops the connection.
    pub async fn execute(&self, sql: &str, max_rows: usize, cancel: &CancellationToken) -> DbResult<QueryResult> {
        self.execute_from(sql, 0, max_rows, cancel).await
    }

    /// [`execute`](Self::execute), reading past the first `skip` rows without keeping them
    /// (a later page of a result: only that page is decoded and returned).
    pub async fn execute_from(
        &self,
        sql: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> DbResult<QueryResult> {
        let mut connection = Held::acquire(self).await?;
        let result = connection.execute_from(self, sql, skip, max_rows, cancel).await;
        if cancel.is_cancelled() {
            connection.discard().await;
            return Err(DbError::cancelled());
        }
        result
    }

    /// Runs `statements` in one transaction; each must change `expect_one`
    /// row when flagged (table editor submits).
    pub async fn transaction(&self, statements: &[(String, bool)]) -> DbResult<u64> {
        with_pool!(self, pool => {
            let mut transaction = pool.begin().await.map_err(db_err)?;
            let mut total = 0u64;
            for (sql, expect_one) in statements {
                let done = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone()))
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_err)?;
                let changed = done.rows_affected();
                // MySQL reports 0 for an UPDATE that leaves the row unchanged.
                if *expect_one && (changed > 1 || (changed == 0 && !matches!(self, Pool::Mysql(_)))) {
                    return Err(DbError::invalid(format!(
                        "{sql}: expected to change 1 row, changed {changed}; nothing was saved"
                    )));
                }
                total += changed;
            }
            transaction.commit().await.map_err(db_err)?;
            Ok(total)
        })
    }
}

/// A connection taken out of a pool: for one statement, or held by a
/// manual-commit console across statements with its transaction open.
pub enum Held {
    Sqlite(PoolConnection<Sqlite>),
    Postgres(PoolConnection<Postgres>),
    Mysql(PoolConnection<MySql>),
}

impl Held {
    pub async fn acquire(pool: &Pool) -> DbResult<Self> {
        Ok(match pool {
            Pool::Sqlite(pool) => Held::Sqlite(pool.acquire().await.map_err(db_err)?),
            Pool::Postgres(pool) => Held::Postgres(pool.acquire().await.map_err(db_err)?),
            Pool::Mysql(pool) => Held::Mysql(pool.acquire().await.map_err(db_err)?),
        })
    }

    /// Runs a statement without results (`BEGIN`, `COMMIT`, `ROLLBACK`).
    pub async fn command(&mut self, sql: &str) -> DbResult<()> {
        let sql = sqlx::AssertSqlSafe(sql.to_owned());
        match self {
            Held::Sqlite(connection) => sqlx::raw_sql(sql).execute(&mut **connection).await.map(drop),
            Held::Postgres(connection) => sqlx::raw_sql(sql).execute(&mut **connection).await.map(drop),
            Held::Mysql(connection) => sqlx::raw_sql(sql).execute(&mut **connection).await.map(drop),
        }
        .map_err(db_err)
    }

    /// Closes the connection instead of returning it to the pool (its statement was
    /// interrupted; an open transaction is rolled back by the server).
    pub async fn discard(self) {
        match self {
            Held::Sqlite(connection) => drop(connection.detach()),
            Held::Postgres(connection) => {
                let _ = connection.detach().close().await;
            }
            Held::Mysql(connection) => {
                let _ = connection.detach().close().await;
            }
        }
    }

    /// Runs one statement on this connection (see [`Pool::execute`]); after a
    /// cancellation the caller must [`discard`](Self::discard) it.
    pub async fn execute(
        &mut self,
        pool: &Pool,
        sql: &str,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> DbResult<QueryResult> {
        self.execute_from(pool, sql, 0, max_rows, cancel).await
    }

    /// [`execute`](Self::execute), reading past the first `skip` rows without keeping them
    /// (see [`Pool::execute_from`]).
    pub async fn execute_from(
        &mut self,
        pool: &Pool,
        sql: &str,
        skip: usize,
        max_rows: usize,
        cancel: &CancellationToken,
    ) -> DbResult<QueryResult> {
        let started = Instant::now();
        // `$id`: the query naming the server process, `$kill`: how another connection stops it.
        macro_rules! run {
            ($conn:expr, $id:expr, $kill:expr) => {{
                let backend = match $id {
                    Some(query) => backend_id!(&mut **$conn, query),
                    None => None,
                };
                let result = tokio::select! {
                    result = async { fetch!(&mut **$conn, sql, skip, max_rows, Cells::Display) } => result,
                    () = cancel.cancelled() => Err(DbError::cancelled()),
                };
                if cancel.is_cancelled() {
                    if let Some(backend) = backend {
                        let _ = pool.rows(&$kill(backend), 1).await;
                    }
                    return Err(DbError::cancelled());
                }
                let mut result = result?;
                if result.0.is_empty() && looks_like_query(sql) {
                    result.0 = (&mut **$conn)
                        .prepare(sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str())
                        .await
                        .map(|statement| statement_columns(&statement))
                        .unwrap_or_default();
                }
                result
            }};
        }
        let fetched: Fetched = match self {
            Held::Sqlite(connection) => run!(connection, None::<&str>, |_: String| String::new()),
            Held::Postgres(connection) => {
                run!(connection, Some("SELECT pg_backend_pid()"), |backend: String| format!(
                    "SELECT pg_cancel_backend({backend})"
                ))
            }
            Held::Mysql(connection) => {
                run!(connection, Some("SELECT CONNECTION_ID()"), |backend: String| format!("KILL QUERY {backend}"))
            }
        };
        let (columns, rows, affected, has_more, first) = fetched;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(QueryResult {
            statement: sql.to_owned(),
            affected: if columns.is_empty() { Some(affected.unwrap_or(0) as f64) } else { None },
            columns,
            rows,
            has_more,
            elapsed_ms,
            execution_ms: first.map_or(elapsed_ms, |first| first.duration_since(started).as_secs_f64() * 1000.0),
        })
    }
}

/// The statement opening a transaction.
pub fn begin_statement(driver: DbDriver) -> &'static str {
    match driver {
        DbDriver::Mysql => "START TRANSACTION",
        DbDriver::Sqlite | DbDriver::Postgres => "BEGIN",
        // Those drivers open a transaction implicitly, or are not ported yet.
        DbDriver::SqlServer | DbDriver::Oracle | DbDriver::Clickhouse => "",
    }
}

fn statement_columns<S: sqlx::Statement>(statement: &S) -> Vec<ResultColumn> {
    statement
        .columns()
        .iter()
        .map(|column| ResultColumn {
            name: column.name().to_owned(),
            type_name: column.type_info().name().to_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{DbOptions, DbProperty};

    fn prop(name: &str, value: &str) -> DbProperty {
        DbProperty { name: name.into(), value: value.into() }
    }

    #[test]
    fn postgres_options_become_runtime_parameters() {
        let source = DataSource {
            driver: DbDriver::Postgres,
            read_only: true,
            options: DbOptions {
                default_schema: "app, public".into(),
                time_zone: "Europe/Paris".into(),
                startup_script: "SET work_mem = '64MB'; select 1;".into(),
                ..Default::default()
            },
            properties: vec![prop("statement_timeout", "5s"), prop("application_name", "me"), prop("", "x")],
            ..Default::default()
        };
        let setup = Setup::of(&source).unwrap();
        let names: Vec<_> = setup.params.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["default_transaction_read_only", "search_path", "TimeZone", "statement_timeout"]);
        assert_eq!(setup.application_name.as_deref(), Some("me"));
        assert_eq!(setup.statements, ["SET work_mem = '64MB'", "select 1"]);
    }

    #[test]
    fn mysql_properties_become_session_variables() {
        let source = DataSource {
            driver: DbDriver::Mysql,
            read_only: true,
            properties: vec![
                prop("sql_mode", "ANSI_QUOTES"),
                prop("max_execution_time", "1000"),
                prop("charset", "utf8mb4"),
                prop("connect-timeout", "5"),
            ],
            ..Default::default()
        };
        let setup = Setup::of(&source).unwrap();
        assert_eq!(
            setup.statements,
            [
                "SET SESSION TRANSACTION READ ONLY",
                "SET SESSION sql_mode = 'ANSI_QUOTES'",
                "SET SESSION max_execution_time = 1000"
            ]
        );
        assert_eq!(setup.charset.as_deref(), Some("utf8mb4"));
        assert_eq!(setup.connect_timeout, Some(Duration::from_secs(5)));
        assert!(Setup::of(&DataSource { properties: vec![prop("a; drop", "1")], ..source.clone() }).is_err());
        assert!(Setup::of(&DataSource { properties: vec![prop("connect_timeout", "soon")], ..source }).is_err());
    }

    #[test]
    fn sqlite_properties_become_pragmas() {
        let source = DataSource { properties: vec![prop("cache_size", "-2000")], ..Default::default() };
        assert_eq!(Setup::of(&source).unwrap().params, [("cache_size".to_owned(), "-2000".to_owned())]);
    }

    #[test]
    fn only_bytes_typed_values_are_binary() {
        // (type name as the driver reports it, the driver reads it as text, binary)
        let cases = [
            ("VARBINARY", false, true),
            ("BLOB", false, true),
            ("LONGBLOB", false, true),
            ("BINARY", false, true),
            // MySQL catalog columns (`utf8mb3_bin`) and `utf8mb4_bin` text: flagged BINARY.
            ("VARBINARY", true, false),
            ("BLOB", true, false),
            ("VARCHAR", true, false),
            ("TEXT", true, false),
            ("BYTEA", false, false),
            ("INT", false, false),
        ];
        for (name, text, binary) in cases {
            assert_eq!(binary_type(name, text), binary, "{name} text={text}");
        }
    }

    #[test]
    fn catalog_bytes_are_names_and_grid_bytes_are_hex() {
        // `oi_数据` as MySQL sends it under `character_set_results = binary`.
        let name = "oi_数据".as_bytes().to_vec();
        assert_eq!(bytes_text(name.clone(), Cells::Text), "oi_数据");
        assert_eq!(bytes_text(name, Cells::Display), "oi_数据");
        assert_eq!(bytes_text(vec![0xCA, 0xFE], Cells::Display), "0xCAFE");
        assert_eq!(bytes_text(vec![b'a', 0xFF], Cells::Text), "a\u{FFFD}");
    }

    #[test]
    fn expands_only_home_relative_paths() {
        assert_eq!(file_setting("  "), None);
        assert_eq!(file_setting("/etc/ca.pem"), Some(PathBuf::from("/etc/ca.pem")));
        if let Some(home) = home_dir() {
            assert_eq!(file_setting("~/ca.pem"), Some(home.join("ca.pem")));
        }
    }

    #[test]
    fn recognises_queries_by_their_first_keyword() {
        assert!(looks_like_query("-- comment\nSELECT 1"));
        assert!(looks_like_query("with a as (select 1) select * from a"));
        assert!(!looks_like_query("INSERT INTO t VALUES (1)"));
    }
}
