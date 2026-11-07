//! The execution plan path against a real SQLite file: the statement the
//! dialect needs, a real `Pool` answer and the tree the Plan tab renders.

use std::path::Path;

use db_core::conn::Pool;
use db_core::error::DbErrorCode;
use db_core::manager::DbManager;
use db_core::plan;
use db_core::source::{DataSource, DbDriver};
use tokio_util::sync::CancellationToken;

fn database(dir: &Path) -> String {
    let file = dir.join("test.db");
    // An empty file is a valid, empty SQLite database.
    std::fs::write(&file, "").unwrap();
    file.to_string_lossy().into_owned()
}

fn sqlite_source(id: &str, file: String) -> DataSource {
    DataSource { id: id.into(), name: id.into(), driver: DbDriver::Sqlite, file: Some(file), ..Default::default() }
}

#[tokio::test]
async fn explains_a_sqlite_statement_through_a_pool() {
    let dir = tempfile::tempdir().unwrap();
    let source = sqlite_source("s", database(dir.path()));
    let pool = Pool::connect(&source, None, None).await.unwrap();
    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)",
        "CREATE INDEX item_name ON item(name)",
        "INSERT INTO item (name) VALUES ('a')",
    ] {
        pool.execute(statement, 0, &cancel).await.unwrap();
    }

    // A trailing semicolon is allowed and never doubled.
    let statement = plan::explain_statement(DbDriver::Sqlite, "SELECT id, name FROM item WHERE name = 'a';");
    assert_eq!(statement, "EXPLAIN QUERY PLAN SELECT id, name FROM item WHERE name = 'a'");

    let result = pool.execute(&statement, 100, &cancel).await.unwrap();
    let columns: Vec<String> = result.columns.iter().map(|column| column.name.clone()).collect();
    let nodes = plan::parse(DbDriver::Sqlite, &columns, &result.rows).unwrap();

    assert!(!nodes.is_empty());
    assert_eq!(nodes[0].parent, None, "the first node is the root of the plan");
    assert_eq!(nodes[0].depth, 0);
    assert!(nodes.iter().all(|node| node.parent.map_or(true, |parent| parent < node.id)));
    assert!(nodes.iter().all(|node| !node.operation.is_empty()), "{nodes:?}");
    pool.close().await;
}

#[tokio::test]
async fn the_manager_explains_and_refuses_the_drivers_without_a_plan() {
    let dir = tempfile::tempdir().unwrap();
    let manager = DbManager::new(dir.path().join("db"));
    manager.set_root(Some(dir.path().join("project").to_string_lossy().into_owned()));
    let mut sources = vec![sqlite_source("local", database(dir.path()))];
    sources.extend([("ms", DbDriver::SqlServer), ("ch", DbDriver::Clickhouse), ("ora", DbDriver::Oracle)].map(
        |(id, driver)| DataSource { id: id.into(), name: id.into(), driver, global: true, ..Default::default() },
    ));
    manager.save_sources(sources).await.unwrap();

    let cancel = CancellationToken::new();
    for statement in [
        "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)",
        "INSERT INTO item (name) VALUES ('a')",
    ] {
        manager.execute("local", statement, 0, &cancel).await.unwrap();
    }
    let nodes = manager.explain("local", "SELECT id, name FROM item WHERE id = 1").await.unwrap();
    assert!(!nodes.is_empty());
    assert_eq!(nodes[0].parent, None);

    for id in ["ms", "ch", "ora"] {
        let error = manager.explain(id, "SELECT 1").await.unwrap_err();
        assert_eq!(error.code, DbErrorCode::Invalid, "{id}: {error:?}");
        assert_eq!(error.message, "explain is not supported for this driver");
    }

    // An unknown target is reported before any plan is read.
    assert_eq!(manager.explain("gone", "SELECT 1").await.unwrap_err().code, DbErrorCode::NotFound);
}
