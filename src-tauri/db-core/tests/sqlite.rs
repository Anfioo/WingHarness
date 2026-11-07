//! End-to-end checks against a real SQLite file: no server to install, and the
//! path from a data source to a result grid is the same for every driver.

use std::path::PathBuf;
use std::time::Duration;

use db_core::conn::Pool;
use db_core::error::DbErrorCode;
use db_core::manager::DbManager;
use db_core::source::{DataSource, DbDriver};
use db_core::{CellValue, DbRowEdit, DbTableKind, SortKey, SqlStatement, TriggerInfo};
use tokio_util::sync::CancellationToken;

fn database(dir: &std::path::Path) -> String {
    let file = dir.join("test.db");
    // An empty file is a valid, empty SQLite database.
    std::fs::write(&file, "").unwrap();
    file.to_string_lossy().into_owned()
}

fn source(id: &str, file: String) -> DataSource {
    DataSource { id: id.into(), name: id.into(), driver: DbDriver::Sqlite, file: Some(file), ..Default::default() }
}

/// A manager whose only data source is the temporary SQLite file of `dir`.
async fn manager(dir: &std::path::Path) -> DbManager {
    let manager = DbManager::new(dir.join("db"));
    manager.set_root(Some(dir.join("project").to_string_lossy().into_owned()));
    manager.save_sources(vec![source("s", database(dir))]).await.unwrap();
    manager
}

#[tokio::test]
async fn runs_statements_and_reads_every_value_as_text() {
    let dir = tempfile::tempdir().unwrap();
    let source = source("s", database(dir.path()));
    let pool = Pool::connect(&source, None, None).await.unwrap();
    let cancel = CancellationToken::new();
    pool.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)", 0, &cancel).await.unwrap();
    let inserted = pool
        .execute("INSERT INTO t (name, data) VALUES ('a', x'00FF'), (NULL, NULL)", 0, &cancel)
        .await
        .unwrap();
    assert_eq!(inserted.affected, Some(2.0));
    assert!(inserted.columns.is_empty());

    let result = pool.execute("SELECT id, name, data FROM t ORDER BY id", 100, &cancel).await.unwrap();
    assert_eq!(
        result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
        ["id", "name", "data"]
    );
    assert_eq!(
        result.rows,
        [
            [Some("1".into()), Some("a".into()), Some("0x00FF".into())],
            [Some("2".into()), None, None],
        ]
    );
    assert!(!result.has_more);
    assert_eq!(result.affected, None);

    // Only the requested page is kept, and the caller learns there is more.
    let page = pool.execute("SELECT id FROM t ORDER BY id", 1, &cancel).await.unwrap();
    assert_eq!(page.rows, [[Some("1".into())]]);
    assert!(page.has_more);
    pool.close().await;
}

#[tokio::test]
async fn reports_sql_errors_without_losing_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let pool = Pool::connect(&source("s", database(dir.path())), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    let error = pool.execute("SELECT * FROM missing", 10, &cancel).await.unwrap_err();
    assert_eq!(error.code, DbErrorCode::Invalid);
    assert!(error.message.contains("missing"), "{}", error.message);
    // The pool is still usable afterwards.
    assert_eq!(pool.execute("SELECT 1", 1, &cancel).await.unwrap().rows, [[Some("1".into())]]);
    pool.close().await;
}

#[tokio::test]
async fn a_missing_file_is_not_created_behind_the_users_back() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("nope.db");
    let error = match Pool::connect(&source("s", file.to_string_lossy().into_owned()), None, None).await {
        Ok(_) => panic!("a missing database file must not be created"),
        Err(error) => error,
    };
    assert!(!file.exists());
    assert!(matches!(error.code, DbErrorCode::Invalid | DbErrorCode::Unreachable), "{error:?}");
}

#[tokio::test]
async fn cancelling_stops_a_long_statement() {
    let dir = tempfile::tempdir().unwrap();
    let pool = Pool::connect(&source("s", database(dir.path())), None, None).await.unwrap();
    let cancel = CancellationToken::new();
    let sleeper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        sleeper.cancel();
    });
    let long = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 50000000) SELECT count(*) FROM c";
    let error = pool.execute(long, 10, &cancel).await.unwrap_err();
    assert!(error.is_cancelled(), "{error:?}");
    // The interrupted connection is gone; the pool opens a fresh one.
    assert_eq!(pool.execute("SELECT 1", 1, &CancellationToken::new()).await.unwrap().rows, [[Some("1".into())]]);
    pool.close().await;
}

#[tokio::test]
async fn a_manual_commit_console_rolls_back_what_it_did_not_commit() {
    let dir = tempfile::tempdir().unwrap();
    let file = database(dir.path());
    let manager = DbManager::new(dir.path().join("db"));
    manager.set_root(Some(dir.path().join("project").to_string_lossy().into_owned()));
    manager.save_sources(vec![source("s", file)]).await.unwrap();
    let cancel = CancellationToken::new();
    manager.execute("s", "CREATE TABLE t (v INTEGER)", 0, &cancel).await.unwrap();

    manager.set_manual_commit("s", true).await.unwrap();
    manager.execute("s", "INSERT INTO t VALUES (1)", 0, &cancel).await.unwrap();
    let inside = manager.execute("s", "SELECT count(*) FROM t", 1, &cancel).await.unwrap();
    assert_eq!(inside.rows, [[Some("1".into())]], "the console sees its own uncommitted rows");
    manager.finish_transaction("s", false).await.unwrap();
    let after = manager.execute("s", "SELECT count(*) FROM t", 1, &cancel).await.unwrap();
    assert_eq!(after.rows, [[Some("0".into())]]);

    manager.execute("s", "INSERT INTO t VALUES (2)", 0, &cancel).await.unwrap();
    manager.finish_transaction("s", true).await.unwrap();
    manager.set_manual_commit("s", false).await.unwrap();
    let committed = manager.execute("s", "SELECT count(*) FROM t", 1, &cancel).await.unwrap();
    assert_eq!(committed.rows, [[Some("1".into())]]);

    // Statements are remembered per data source, newest first.
    let history = manager.history("s").await.unwrap();
    assert_eq!(history.first().map(|entry| entry.text.as_str()), Some("SELECT count(*) FROM t"));
    manager.remove_history("s", None).await.unwrap();
    assert!(manager.history("s").await.unwrap().is_empty());
}

#[tokio::test]
async fn a_relative_sqlite_path_is_resolved_against_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("app.db"), "").unwrap();
    let manager = DbManager::new(dir.path().join("db"));
    manager.set_root(Some(project.to_string_lossy().into_owned()));
    manager.save_sources(vec![source("s", "app.db".into()), source("probe", "app.db".into())]).await.unwrap();
    let cancel = CancellationToken::new();
    manager.execute("s", "CREATE TABLE t (v INTEGER)", 0, &cancel).await.unwrap();
    assert!(project.join("app.db").metadata().unwrap().len() > 0);
    // Test Connection opens its own pool, reports what it reached and closes it again.
    let version = manager.test(&manager.source("probe").unwrap(), None).await.unwrap();
    assert!(version.starts_with("SQLite "), "{version}");
    assert!(!manager.is_connected("probe"));
}

#[tokio::test]
async fn a_password_is_never_part_of_the_files_the_feature_writes() {
    let dir = tempfile::tempdir().unwrap();
    let manager = DbManager::new(dir.path().join("db"));
    manager.set_root(Some(dir.path().join("project").to_string_lossy().into_owned()));
    manager.save_sources(vec![source("s", database(dir.path()))]).await.unwrap();
    manager.set_password("s", Some("hunter2-secret".into()), true).unwrap();
    let mut found = Vec::<PathBuf>::new();
    for entry in walk(dir.path()) {
        let Ok(text) = std::fs::read_to_string(&entry) else { continue };
        if text.contains("hunter2-secret") && !entry.to_string_lossy().ends_with("secrets.json") {
            found.push(entry);
        }
    }
    assert!(found.is_empty(), "the password leaked into {found:?}");
}

#[tokio::test]
async fn introspects_tables_columns_indexes_keys_and_triggers() {
    let dir = tempfile::tempdir().unwrap();
    let manager = DbManager::new(dir.path().join("db"));
    manager.set_root(Some(dir.path().join("project").to_string_lossy().into_owned()));
    manager.save_sources(vec![source("s", database(dir.path()))]).await.unwrap();
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, \
         parent_id INTEGER REFERENCES parent(id), note TEXT NOT NULL DEFAULT 'x')",
        "CREATE VIEW parent_names AS SELECT name FROM parent",
        "CREATE INDEX child_parent ON child(parent_id)",
        "CREATE TRIGGER child_insert AFTER INSERT ON child BEGIN SELECT 1; END",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    assert_eq!(manager.schemas("s").await.unwrap(), ["main"]);
    let tables = manager.tables("s", "main").await.unwrap();
    assert!(tables.iter().any(|table| table.name == "parent" && table.kind == DbTableKind::Table));
    assert!(tables.iter().any(|table| table.name == "parent_names" && table.kind == DbTableKind::View));
    // SQLite's internal catalog tables never show up.
    assert!(tables.iter().all(|table| !table.name.starts_with("sqlite_")));

    let details = manager.table_details("s", "main", "child").await.unwrap();
    let columns: Vec<_> = details.columns.iter().map(|column| column.name.as_str()).collect();
    assert_eq!(columns, ["id", "parent_id", "note"]);
    assert!(details.columns[0].primary_key);
    assert!(details.columns[1].nullable);
    assert!(!details.columns[2].nullable);
    assert_eq!(details.columns[2].default.as_deref(), Some("'x'"));
    assert!(details.indexes.iter().any(|index| index.name == "child_parent" && index.columns == ["parent_id"]));
    assert_eq!(details.foreign_keys.len(), 1);
    assert_eq!(details.foreign_keys[0].ref_table, "parent");
    assert_eq!(details.foreign_keys[0].ref_columns, ["id"]);
    assert_eq!(
        details.triggers,
        [TriggerInfo { name: "child_insert".into(), timing: "after".into(), events: "insert".into() }]
    );

    // SQLite has no routines or sequences, but the call still succeeds.
    let objects = manager.schema_objects("s", "main").await.unwrap();
    assert!(objects.routines.is_empty());
    assert!(objects.sequences.is_empty());

    // Only PostgreSQL lists databases; a SQLite source says so instead.
    let error = manager.databases("s").await.unwrap_err();
    assert!(error.message.contains("only PostgreSQL"), "{}", error.message);
}

#[tokio::test]
async fn pages_a_table() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER)",
        "INSERT INTO item (name, amount) VALUES ('a', 10), ('b', 20), ('c', 30)",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    // The page query reads one row past the limit, so `has_more` needs no count.
    let first = manager.table_page("s", "main", "item", None, &[], 0, 2, &cancel).await.unwrap();
    assert_eq!(first.offset, 0.0);
    assert_eq!(first.result.rows.len(), 2);
    assert!(first.result.has_more);
    assert_eq!(
        first.details.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
        ["id", "name", "amount"]
    );
    assert_eq!(
        first.result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
        ["id", "name", "amount"]
    );

    let last = manager.table_page("s", "main", "item", None, &[], 2, 2, &cancel).await.unwrap();
    assert_eq!(last.offset, 2.0);
    assert_eq!(last.result.rows.len(), 1);
    assert!(!last.result.has_more);

    let filtered = manager
        .table_page("s", "main", "item", Some("amount >= 20"), &[], 0, 10, &cancel)
        .await
        .unwrap();
    assert_eq!(filtered.result.rows.iter().map(|row| row[1].as_deref()).collect::<Vec<_>>(), [Some("b"), Some("c")]);

    let sorted = manager
        .table_page("s", "main", "item", None, &[SortKey { column: "amount".into(), descending: true }], 0, 10, &cancel)
        .await
        .unwrap();
    assert_eq!(sorted.result.rows[0][1], Some("c".into()));
}

#[tokio::test]
async fn applies_row_edits_in_one_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT)",
        "INSERT INTO person (id, name) VALUES (1, 'a')",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    let key = |id: &str| vec![CellValue { column: "id".into(), value: Some(id.into()) }];
    let applied = vec![
        DbRowEdit::Update { key: key("1"), values: vec![CellValue { column: "name".into(), value: Some("b".into()) }] },
        DbRowEdit::Insert {
            values: vec![
                CellValue { column: "id".into(), value: Some("2".into()) },
                CellValue { column: "name".into(), value: Some("c".into()) },
            ],
        },
    ];
    assert_eq!(manager.apply_edits("s", "main", "person", &applied).await.unwrap(), 2.0);
    let rows = manager.execute("s", "SELECT id, name FROM person ORDER BY id", 10, &cancel).await.unwrap().rows;
    assert_eq!(rows, [[Some("1".into()), Some("b".into())], [Some("2".into()), Some("c".into())]]);

    // A key that matches no row fails the batch, and the insert before it is
    // rolled back with it.
    let failed = vec![
        DbRowEdit::Delete { key: key("999") },
        DbRowEdit::Insert {
            values: vec![
                CellValue { column: "id".into(), value: Some("3".into()) },
                CellValue { column: "name".into(), value: Some("d".into()) },
            ],
        },
    ];
    let error = manager.apply_edits("s", "main", "person", &failed).await.unwrap_err();
    assert_eq!(error.code, DbErrorCode::Invalid);
    let count = manager.execute("s", "SELECT count(*) FROM person", 1, &cancel).await.unwrap().rows;
    assert_eq!(count, [[Some("2".into())]]);
}

#[tokio::test]
async fn reads_table_ddl() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        "CREATE INDEX item_name ON item(name)",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    let ddl = manager.ddl("s", "main", "item").await.unwrap();
    assert!(ddl.contains("CREATE TABLE"), "{ddl}");
    assert!(ddl.contains("CREATE INDEX"), "{ddl}");
    assert!(ddl.trim_end().ends_with(';'), "{ddl}");

    let missing = manager.ddl("s", "main", "nope").await.unwrap_err();
    assert_eq!(missing.code, DbErrorCode::NotFound);
}

#[tokio::test]
async fn builds_a_completion_model() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT)",
        "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), note TEXT)",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    let model = manager.completion("s").await.unwrap();
    assert_eq!(model.default_schema, "main");
    let names: Vec<&str> = model.tables.iter().map(|table| table.name.as_str()).collect();
    assert!(names.contains(&"parent") && names.contains(&"child"), "{names:?}");

    let child = model.tables.iter().find(|table| table.name == "child").unwrap();
    assert_eq!(
        child.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
        ["id", "parent_id", "note"]
    );
    assert!(child.columns[0].primary_key);
    assert!(child.columns[1].nullable);
    assert!(child.columns[2].nullable);

    assert_eq!(model.foreign_keys.len(), 1);
    let key = &model.foreign_keys[0];
    assert_eq!((key.schema.as_str(), key.table.as_str()), ("main", "child"));
    assert_eq!((key.ref_schema.as_str(), key.ref_table.as_str()), ("main", "parent"));
    assert_eq!(key.columns, ["parent_id"]);
    assert_eq!(key.ref_columns, ["id"]);
}

#[tokio::test]
async fn runs_statements_in_order_and_stops_at_the_first_error() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    let statements: Vec<SqlStatement> = [
        (0, 8, "SELECT 1"),
        (10, 17, "SELEC 2"),
        (19, 27, "SELECT 3"),
    ]
    .into_iter()
    .map(|(from, to, text)| SqlStatement { from, to, text: text.into() })
    .collect();

    let outcomes = manager.execute_all("s", &statements, 0, 10, &cancel).await.unwrap();
    assert_eq!(outcomes.len(), 2, "the statement after the failure never runs");
    assert!(outcomes[0].error.is_none());
    assert_eq!(outcomes[0].result.as_ref().unwrap().rows, [[Some("1".into())]]);
    assert_eq!(outcomes[1].statement.text, "SELEC 2");
    assert!(outcomes[1].result.is_none());
    assert_eq!(outcomes[1].error.as_ref().unwrap().code, DbErrorCode::Invalid);
}

#[tokio::test]
async fn refuses_row_edits_on_a_table_without_a_primary_key() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE note (label TEXT, body TEXT)",
        "INSERT INTO note (label, body) VALUES ('a', 'x')",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    let key = vec![CellValue { column: "label".into(), value: Some("a".into()) }];
    let edits = [
        DbRowEdit::Update {
            key: key.clone(),
            values: vec![CellValue { column: "body".into(), value: Some("y".into()) }],
        },
        DbRowEdit::Delete { key },
    ];
    for edit in edits {
        let error = manager.apply_edits("s", "main", "note", &[edit]).await.unwrap_err();
        assert_eq!(error.code, DbErrorCode::Invalid);
        assert!(error.message.contains("primary key"), "{}", error.message);
    }
    // Nothing was changed, and an insert needs no key so it still goes through.
    let rows = manager.execute("s", "SELECT label, body FROM note ORDER BY label", 10, &cancel).await.unwrap().rows;
    assert_eq!(rows, [[Some("a".into()), Some("x".into())]]);
    let inserted = vec![DbRowEdit::Insert {
        values: vec![
            CellValue { column: "label".into(), value: Some("b".into()) },
            CellValue { column: "body".into(), value: Some("z".into()) },
        ],
    }];
    assert_eq!(manager.apply_edits("s", "main", "note", &inserted).await.unwrap(), 1.0);
}

#[tokio::test]
async fn a_zero_row_limit_is_clamped_to_one_row() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE item (id INTEGER PRIMARY KEY)",
        "INSERT INTO item (id) VALUES (1), (2)",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    let statements = [SqlStatement { from: 0, to: 28, text: "SELECT id FROM item ORDER BY id".into() }];
    let outcomes = manager.execute_all("s", &statements, 0, 0, &cancel).await.unwrap();
    let result = outcomes[0].result.as_ref().unwrap();
    assert_eq!(result.rows, [[Some("1".into())]], "a zero limit becomes one row, not an empty page");
    assert!(result.has_more, "the extra row still tells the caller there is more");
}

#[tokio::test]
async fn reads_view_ddl() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager(dir.path()).await;
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)",
        "CREATE VIEW names AS SELECT name FROM item",
    ] {
        manager.execute("s", statement, 0, &cancel).await.unwrap();
    }

    let ddl = manager.ddl("s", "main", "names").await.unwrap();
    let lowered = ddl.to_lowercase();
    assert!(lowered.contains("create view"), "{ddl}");
    assert!(lowered.contains(" as "), "{ddl}");
    assert!(ddl.trim_end().ends_with(';'), "{ddl}");
}

#[test]
fn picks_the_statement_for_a_caret_and_for_a_selection() {
    use db_core::split::{statement_at, statements_in};

    let text = "SELECT 1;\nSELECT 2;\nSELECT 3";
    // A caret inside a statement runs that statement.
    assert_eq!(statement_at(text, 3, DbDriver::Sqlite).unwrap().text, "SELECT 1");
    assert_eq!(statement_at(text, 14, DbDriver::Sqlite).unwrap().text, "SELECT 2");
    // A caret just past the semicolon stays with the statement it ends.
    assert_eq!(statement_at(text, 9, DbDriver::Sqlite).unwrap().text, "SELECT 1");

    // One blank line between two statements still keeps the caret on the previous
    // one; two blank lines move it to the next.
    let spaced = "SELECT 1;\n\n\nSELECT 2";
    assert_eq!(statement_at(spaced, 10, DbDriver::Sqlite).unwrap().text, "SELECT 1");
    assert_eq!(statement_at(spaced, 11, DbDriver::Sqlite).unwrap().text, "SELECT 2");

    // A selection is split on its own: none of it is expanded to a whole statement.
    let selected = statements_in("SELECT 1;\nSELECT 2", 4, 13, DbDriver::Sqlite);
    assert_eq!(
        selected.iter().map(|statement| statement.text.as_str()).collect::<Vec<_>>(),
        ["CT 1", "SEL"]
    );
    assert_eq!(selected[0].from, 4);
    assert_eq!(selected[1].from, 10);
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return files };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[test]
fn a_workspace_round_trips_queries_tabs_and_settings() {
    use db_core::{DbSettings, TabRecord, WindowTabs, Workspace};

    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::new(dir.path().join("db"));

    workspace.write_query("one.sql", "SELECT 1").unwrap();
    let names: Vec<_> = workspace.queries().unwrap().into_iter().map(|file| file.name).collect();
    assert_eq!(names, ["one.sql"]);
    assert_eq!(workspace.read_query("one.sql").unwrap(), "SELECT 1");

    workspace
        .save_window_tabs(WindowTabs {
            source: "s".into(),
            tabs: vec![TabRecord::Query { file: "one.sql".into() }],
            active: Some("query:one.sql".into()),
        })
        .unwrap();
    let first = workspace.window_tabs("s").unwrap().unwrap();
    assert_eq!(first.tabs, vec![TabRecord::Query { file: "one.sql".into() }]);
    assert_eq!(first.active.as_deref(), Some("query:one.sql"));

    // A second window adds its entry without replacing the first one.
    workspace
        .save_window_tabs(WindowTabs {
            source: "t".into(),
            tabs: vec![TabRecord::Table { target: "t".into(), schema: "main".into(), table: "users".into() }],
            active: None,
        })
        .unwrap();
    assert_eq!(workspace.window_tabs("s").unwrap().unwrap().tabs.len(), 1);
    assert_eq!(workspace.window_tabs("t").unwrap().unwrap().tabs.len(), 1);
    assert!(workspace.window_tabs("missing").unwrap().is_none());

    workspace.save_settings(DbSettings { version: 1, console_rows: 1000, table_page_size: 1000 }).unwrap();
    assert_eq!(workspace.settings().unwrap().console_rows, 1000);
}

#[test]
fn a_workspace_recovers_from_a_damaged_tabs_file() {
    use db_core::Workspace;

    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::new(dir.path().join("db"));
    std::fs::create_dir_all(dir.path().join("db")).unwrap();
    std::fs::write(dir.path().join("db").join("windows.json"), "{damaged").unwrap();

    assert!(workspace.window_tabs("s").unwrap().is_none());
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("db"))
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("windows.json.bak-"))
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");

    // The damaged file is gone, so a save starts from a clean slate.
    workspace
        .save_window_tabs(db_core::WindowTabs {
            source: "s".into(),
            tabs: vec![db_core::TabRecord::Query { file: "one.sql".into() }],
            active: None,
        })
        .unwrap();
    assert_eq!(workspace.window_tabs("s").unwrap().unwrap().tabs.len(), 1);
}
