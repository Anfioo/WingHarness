//! The execution plan of a statement, normalised to one tree the frontend
//! renders whatever the driver's `EXPLAIN` output looks like.
//
// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.
// The Oracle, SQL Server and ClickHouse branches of the reference are not
// carried over: only SQLite, PostgreSQL and MySQL produce a plan here.

use serde_json::{Map, Value};

use crate::error::{DbError, DbResult};
use crate::models::{PlanNode, PlanProperty};
use crate::source::DbDriver;

/// Characters of an `EXPLAIN` answer an error message quotes back.
const EXCERPT_CHARS: usize = 200;

/// The statement to send to the server to obtain a plan.
///
/// `statement` may end with a semicolon; the prefix is never repeated.
pub fn explain_statement(driver: DbDriver, statement: &str) -> String {
    let body = statement.trim().trim_end_matches(';');
    match driver {
        DbDriver::Sqlite => format!("EXPLAIN QUERY PLAN {body}"),
        DbDriver::Postgres => format!("EXPLAIN (FORMAT JSON) {body}"),
        DbDriver::Mysql => format!("EXPLAIN FORMAT=JSON {body}"),
        // `DbManager::explain` refuses these before executing anything.
        DbDriver::SqlServer | DbDriver::Clickhouse | DbDriver::Oracle => statement.to_owned(),
    }
}

/// The plan tree of one `EXPLAIN` result set.
///
/// `columns` are the column names of `rows`, both as the driver returned them.
/// The nodes come back depth first and a parent always precedes its children,
/// so the frontend renders indentation from the array order alone.
pub fn parse(driver: DbDriver, columns: &[String], rows: &[Vec<Option<String>>]) -> DbResult<Vec<PlanNode>> {
    match driver {
        DbDriver::Sqlite => sqlite(columns, rows),
        DbDriver::Postgres => postgres(columns, rows),
        DbDriver::Mysql => mysql(columns, rows),
        DbDriver::SqlServer | DbDriver::Clickhouse | DbDriver::Oracle => {
            Err(DbError::invalid("explain is not supported for this driver"))
        }
    }
}

fn prop(name: &str, value: impl Into<String>) -> PlanProperty {
    PlanProperty { name: name.to_owned(), value: value.into() }
}

/// A scalar JSON value as text; arrays and objects have no place in the panel.
fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

/// The scalar fields of `object` as properties.
fn scalars(object: &Map<String, Value>) -> Vec<PlanProperty> {
    object.iter().filter_map(|(name, value)| scalar(value).map(|value| prop(name, value))).collect()
}

/// `text` on one line, cut to `EXCERPT_CHARS` characters, for an error message.
fn excerpt(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(EXCERPT_CHARS).collect()
}

/// The first cell of the first row, taken from column `name` when it exists.
fn first_cell(columns: &[String], rows: &[Vec<Option<String>>], name: &str) -> Option<String> {
    let row = rows.first()?;
    let index = columns.iter().position(|column| column.eq_ignore_ascii_case(name)).unwrap_or(0);
    row.get(index).cloned().flatten().filter(|text| !text.trim().is_empty())
}

/// The JSON of an `EXPLAIN` answer, with the text it was read from for errors.
fn plan_json(columns: &[String], rows: &[Vec<Option<String>>], name: &str, what: &str) -> DbResult<(Value, String)> {
    let text = first_cell(columns, rows, name)
        .ok_or_else(|| DbError::protocol(format!("{what} plan: the EXPLAIN result has no rows")))?;
    let json = serde_json::from_str(&text).map_err(|error| {
        DbError::protocol(format!("{what} plan: the EXPLAIN result is not JSON ({error}): {}", excerpt(&text)))
    })?;
    Ok((json, text))
}

/// One `EXPLAIN QUERY PLAN` row, before node ids are assigned.
struct SqliteRow {
    id: String,
    parent: String,
    detail: String,
}

/// SQLite rows: `id, parent, notused, detail` (`SCAN o`, `SEARCH c USING …`).
fn sqlite(columns: &[String], rows: &[Vec<Option<String>>]) -> DbResult<Vec<PlanNode>> {
    if rows.is_empty() {
        return Err(DbError::protocol("SQLite plan: the EXPLAIN QUERY PLAN result is empty"));
    }
    let find = |name: &str| columns.iter().position(|column| column.eq_ignore_ascii_case(name));
    let (id_col, parent_col, detail_col) = match (find("id"), find("parent"), find("detail")) {
        (Some(id), Some(parent), Some(detail)) => (id, parent, detail),
        // Some builds name the columns differently; the order is still id, parent, …, detail.
        _ if rows.iter().all(|row| row.len() >= 4) => (0, 1, 3),
        _ => return Err(DbError::protocol("SQLite plan: expected the id, parent and detail columns")),
    };
    let entries: Vec<SqliteRow> = rows
        .iter()
        .map(|row| SqliteRow {
            id: row.get(id_col).cloned().flatten().unwrap_or_default(),
            parent: row.get(parent_col).cloned().flatten().unwrap_or_default(),
            detail: row.get(detail_col).cloned().flatten().unwrap_or_default(),
        })
        .collect();

    let mut children: Vec<Vec<usize>> = vec![Vec::new(); entries.len()];
    let mut roots = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        // A top-level row points at parent 0, which is not a row of the plan.
        match entries.iter().position(|candidate| candidate.id == entry.parent) {
            Some(parent) if parent != index => children[parent].push(index),
            _ => roots.push(index),
        }
    }

    let mut out = Vec::with_capacity(entries.len());
    let mut visited = vec![false; entries.len()];
    for root in roots {
        sqlite_visit(root, None, 0, &entries, &children, &mut visited, &mut out);
    }
    // Rows a cycle left unreachable still come back, each as its own root.
    for index in 0..entries.len() {
        sqlite_visit(index, None, 0, &entries, &children, &mut visited, &mut out);
    }
    Ok(out)
}

fn sqlite_visit(
    index: usize,
    parent: Option<u32>,
    depth: u32,
    entries: &[SqliteRow],
    children: &[Vec<usize>],
    visited: &mut [bool],
    out: &mut Vec<PlanNode>,
) {
    if std::mem::replace(&mut visited[index], true) {
        return;
    }
    let entry = &entries[index];
    let id = out.len() as u32;
    let (operation, detail) = sqlite_operation(&entry.detail);
    out.push(PlanNode {
        id,
        parent,
        depth,
        operation,
        detail,
        properties: vec![prop("Detail", entry.detail.clone())],
    });
    for &child in &children[index] {
        sqlite_visit(child, Some(id), depth + 1, entries, children, visited, out);
    }
}

/// A SQLite step (`SCAN o`, `SEARCH c USING …`) as an operation and its target.
fn sqlite_operation(detail: &str) -> (String, String) {
    let words: Vec<&str> = detail.split_whitespace().collect();
    let object = |index: usize| words.get(index).map(|word| format!("table: {word};")).unwrap_or_default();
    let using = || detail.find(" USING ").map(|index| detail[index + 1..].to_owned()).unwrap_or_default();
    match words.first().copied() {
        Some("SCAN") if detail.contains(" USING ") => ("Index Scan".into(), format!("{} {}", object(1), using())),
        Some("SCAN") => ("Full Scan".into(), object(1)),
        Some("SEARCH") => ("Index Scan".into(), format!("{} {}", object(1), using()).trim().to_owned()),
        Some("USE") if detail.contains("ORDER BY") => ("Order By".into(), String::new()),
        Some("USE") if detail.contains("GROUP BY") => ("Group By".into(), String::new()),
        Some("USE") if detail.contains("DISTINCT") => ("Distinct".into(), String::new()),
        _ => (detail.to_owned(), String::new()),
    }
}

/// A PostgreSQL `EXPLAIN (FORMAT JSON)` answer: the first row is one array whose
/// entries carry the root `Plan`.
fn postgres(columns: &[String], rows: &[Vec<Option<String>>]) -> DbResult<Vec<PlanNode>> {
    let (json, text) = plan_json(columns, rows, "QUERY PLAN", "PostgreSQL")?;
    let roots = json.as_array().ok_or_else(|| {
        DbError::protocol(format!("PostgreSQL plan: the EXPLAIN result is not an array: {}", excerpt(&text)))
    })?;
    let mut out = Vec::new();
    for root in roots {
        if let Some(plan) = root.get("Plan") {
            postgres_node(plan, None, 0, &mut out);
        }
    }
    if out.is_empty() {
        return Err(DbError::protocol(format!("PostgreSQL plan: the EXPLAIN result has no Plan: {}", excerpt(&text))));
    }
    Ok(out)
}

/// A PostgreSQL plan node: `Node Type`, `Relation Name`, nested `Plans`.
fn postgres_node(node: &Value, parent: Option<u32>, depth: u32, out: &mut Vec<PlanNode>) {
    let text = |key: &str| node.get(key).and_then(Value::as_str).unwrap_or_default();
    let id = out.len() as u32;
    let properties = node
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter(|(name, _)| name.as_str() != "Plans")
                .filter_map(|(name, value)| scalar(value).map(|value| prop(name, value)))
                .collect()
        })
        .unwrap_or_default();
    out.push(PlanNode {
        id,
        parent,
        depth,
        operation: text("Node Type").to_owned(),
        detail: text("Relation Name").to_owned(),
        properties,
    });
    for child in node.get("Plans").and_then(Value::as_array).into_iter().flatten() {
        postgres_node(child, Some(id), depth + 1, out);
    }
}

/// A MySQL `EXPLAIN FORMAT=JSON` answer: the `query_block` and what it holds.
fn mysql(columns: &[String], rows: &[Vec<Option<String>>]) -> DbResult<Vec<PlanNode>> {
    let (json, text) = plan_json(columns, rows, "EXPLAIN", "MySQL")?;
    let block = json.get("query_block").ok_or_else(|| {
        DbError::protocol(format!("MySQL plan: the EXPLAIN result has no query_block: {}", excerpt(&text)))
    })?;
    let mut out = Vec::new();
    mysql_block(block, None, 0, &mut out);
    if out.is_empty() {
        // A block with no table (`SELECT 1`) still has a plan: show the block.
        let properties = block.as_object().map(scalars).unwrap_or_default();
        let operation = block.get("message").and_then(Value::as_str).unwrap_or("Query Block").to_owned();
        out.push(PlanNode { id: 0, parent: None, depth: 0, operation, detail: String::new(), properties });
    }
    Ok(out)
}

/// The contents of one `query_block`: a table access is a node, the operations
/// around it (a join, a sort, a union) are nodes with the tables beneath them.
fn mysql_block(block: &Value, parent: Option<u32>, depth: u32, out: &mut Vec<PlanNode>) {
    let Value::Object(map) = block else { return };
    for (key, value) in map {
        let operation = match key.as_str() {
            "nested_loop" => Some("Nested Loop"),
            "ordering_operation" => Some("Ordering"),
            "grouping_operation" => Some("Grouping"),
            "duplicates_removal" => Some("Duplicates Removal"),
            "union_result" => Some("Union Result"),
            "materialized_from_subquery" => Some("Materialized Subquery"),
            _ => None,
        };
        match (key.as_str(), operation) {
            ("query_block", _) => mysql_block(value, parent, depth, out),
            ("table", _) => mysql_value(value, parent, depth, out),
            (_, Some(operation)) => {
                let id = out.len() as u32;
                let properties = value.as_object().map(scalars).unwrap_or_default();
                out.push(PlanNode {
                    id,
                    parent,
                    depth,
                    operation: operation.to_owned(),
                    detail: String::new(),
                    properties,
                });
                mysql_value(value, Some(id), depth + 1, out);
            }
            (_, None) => mysql_value(value, parent, depth, out),
        }
    }
}

/// Emits a node for each table access in `value`, descending into the objects
/// and arrays that hold them.
fn mysql_value(value: &Value, parent: Option<u32>, depth: u32, out: &mut Vec<PlanNode>) {
    match value {
        Value::Array(items) => {
            for item in items {
                mysql_value(item, parent, depth, out);
            }
        }
        Value::Object(map) if map.contains_key("table_name") || map.contains_key("access_type") => {
            let text = |key: &str| map.get(key).and_then(Value::as_str);
            let id = out.len() as u32;
            out.push(PlanNode {
                id,
                parent,
                depth,
                operation: text("table_name").or_else(|| text("access_type")).unwrap_or("Table").to_owned(),
                detail: text("access_type").unwrap_or_default().to_owned(),
                properties: scalars(map),
            });
            for child in map.values().filter(|value| value.is_object() || value.is_array()) {
                mysql_value(child, Some(id), depth + 1, out);
            }
        }
        Value::Object(map) => {
            for child in map.values() {
                mysql_value(child, parent, depth, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::DbErrorCode;

    fn columns(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    fn rows(values: Vec<Vec<&str>>) -> Vec<Vec<Option<String>>> {
        values.into_iter().map(|row| row.into_iter().map(|cell| Some(cell.to_owned())).collect()).collect()
    }

    fn json_rows(text: &str) -> Vec<Vec<Option<String>>> {
        vec![vec![Some(text.to_owned())]]
    }

    #[test]
    fn explains_per_dialect() {
        assert_eq!(explain_statement(DbDriver::Sqlite, "select 1;"), "EXPLAIN QUERY PLAN select 1");
        assert_eq!(explain_statement(DbDriver::Postgres, " select 1 "), "EXPLAIN (FORMAT JSON) select 1");
        assert_eq!(explain_statement(DbDriver::Mysql, "SELECT 1"), "EXPLAIN FORMAT=JSON SELECT 1");
        // The three drivers without a plan get the statement back unchanged.
        for driver in [DbDriver::SqlServer, DbDriver::Clickhouse, DbDriver::Oracle] {
            assert_eq!(explain_statement(driver, " select 1; "), " select 1; ");
        }
    }

    #[test]
    fn nests_sqlite_rows_depth_first() {
        let plan = parse(
            DbDriver::Sqlite,
            &columns(&["id", "parent", "notused", "detail"]),
            &rows(vec![
                vec!["2", "0", "0", "CO-ROUTINE sub"],
                vec!["3", "2", "0", "SCAN t"],
                vec!["5", "0", "0", "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"],
            ]),
        )
        .unwrap();
        assert_eq!(plan.len(), 3);
        // Depth first: the child of the first root comes before the second root.
        assert_eq!((plan[0].id, plan[0].parent, plan[0].depth), (0, None, 0));
        assert_eq!((plan[1].id, plan[1].parent, plan[1].depth), (1, Some(0), 1));
        assert_eq!((plan[2].id, plan[2].parent, plan[2].depth), (2, None, 0));
        assert_eq!(plan[0].operation, "CO-ROUTINE sub");
        assert_eq!(plan[1].operation, "Full Scan");
        assert_eq!(plan[1].detail, "table: t;");
        assert_eq!(plan[2].operation, "Index Scan");
        assert_eq!(plan[2].detail, "table: c; USING INTEGER PRIMARY KEY (rowid=?)");
        assert!(plan[1].properties.iter().any(|property| property.name == "Detail" && property.value == "SCAN t"));
    }

    #[test]
    fn a_sqlite_child_that_comes_first_still_follows_its_parent() {
        let plan = parse(
            DbDriver::Sqlite,
            &columns(&["id", "parent", "notused", "detail"]),
            &rows(vec![
                vec!["4", "2", "0", "SCAN t"],
                vec!["2", "0", "0", "CO-ROUTINE sub"],
            ]),
        )
        .unwrap();
        assert_eq!(plan[0].operation, "CO-ROUTINE sub");
        assert_eq!((plan[1].parent, plan[1].depth), (Some(0), 1));
    }

    #[test]
    fn reads_postgres_json_trees() {
        let json = r#"[{"Plan": {"Node Type": "Hash Join", "Join Type": "Inner",
            "Total Cost": 12.5, "Output": ["a", "b"], "Plans": [
              {"Node Type": "Seq Scan", "Relation Name": "users", "Alias": "u"},
              {"Node Type": "Index Scan", "Relation Name": "orders", "Index Name": "orders_pkey"}
            ]}}]"#;
        let plan = parse(DbDriver::Postgres, &columns(&["QUERY PLAN"]), &json_rows(json)).unwrap();
        assert_eq!(plan.len(), 3);
        assert_eq!((plan[0].id, plan[0].parent, plan[0].depth), (0, None, 0));
        assert_eq!((plan[0].operation.as_str(), plan[0].detail.as_str()), ("Hash Join", ""));
        assert_eq!((plan[1].parent, plan[1].depth), (Some(0), 1));
        assert_eq!((plan[1].operation.as_str(), plan[1].detail.as_str()), ("Seq Scan", "users"));
        assert_eq!((plan[2].parent, plan[2].depth), (Some(0), 1));
        for name in ["Node Type", "Relation Name"] {
            assert!(plan[1].properties.iter().any(|property| property.name == name), "{name} is in the panel");
        }
        assert!(plan[0].properties.iter().any(|property| property.name == "Total Cost" && property.value == "12.5"));
        // Arrays are skipped, and the nested `Plans` never shows up as a property.
        assert!(plan[0].properties.iter().all(|property| property.name != "Output"));
        assert!(plan[0].properties.iter().all(|property| property.name != "Plans"));
    }

    #[test]
    fn reads_mysql_query_blocks() {
        let json = r#"{"query_block": {"select_id": 1, "table": {
            "table_name": "users", "access_type": "ALL", "rows_examined_per_scan": 10}}}"#;
        let plan = parse(DbDriver::Mysql, &columns(&["EXPLAIN"]), &json_rows(json)).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!((plan[0].id, plan[0].parent, plan[0].depth), (0, None, 0));
        assert_eq!((plan[0].operation.as_str(), plan[0].detail.as_str()), ("users", "ALL"));
        assert!(plan[0].properties.iter().any(|property| property.name == "rows_examined_per_scan"));
    }

    #[test]
    fn nests_mysql_joins_under_the_loop() {
        let json = r#"{"query_block": {"select_id": 1, "nested_loop": [
            {"table": {"table_name": "a", "access_type": "ALL"}},
            {"table": {"table_name": "b", "access_type": "eq_ref", "key": "PRIMARY"}}
        ]}}"#;
        let plan = parse(DbDriver::Mysql, &columns(&["EXPLAIN"]), &json_rows(json)).unwrap();
        assert_eq!(plan.len(), 3);
        assert_eq!((plan[0].operation.as_str(), plan[0].parent, plan[0].depth), ("Nested Loop", None, 0));
        assert_eq!((plan[1].operation.as_str(), plan[1].parent, plan[1].depth), ("a", Some(0), 1));
        assert_eq!((plan[2].operation.as_str(), plan[2].parent, plan[2].depth), ("b", Some(0), 1));
        assert!(plan[2].properties.iter().any(|property| property.name == "key" && property.value == "PRIMARY"));
    }

    #[test]
    fn rejects_answers_it_cannot_read() {
        let invalid = parse(DbDriver::Postgres, &columns(&["QUERY PLAN"]), &json_rows("not json")).unwrap_err();
        assert_eq!(invalid.code, DbErrorCode::Protocol);
        assert!(invalid.message.contains("not json"), "{}", invalid.message);

        let no_plan = parse(DbDriver::Postgres, &columns(&["QUERY PLAN"]), &json_rows(r#"[{"Other": 1}]"#)).unwrap_err();
        assert_eq!(no_plan.code, DbErrorCode::Protocol);

        let no_block = parse(DbDriver::Mysql, &columns(&["EXPLAIN"]), &json_rows(r#"{"other": 1}"#)).unwrap_err();
        assert_eq!(no_block.code, DbErrorCode::Protocol);

        let no_rows = parse(DbDriver::Postgres, &columns(&["QUERY PLAN"]), &[]).unwrap_err();
        assert_eq!(no_rows.code, DbErrorCode::Protocol);

        let no_columns = parse(DbDriver::Sqlite, &[], &[]).unwrap_err();
        assert_eq!(no_columns.code, DbErrorCode::Protocol);

        // SQLite cannot be explained through `parse` without the plan columns.
        let narrow = parse(DbDriver::Sqlite, &columns(&["a", "b"]), &rows(vec![vec!["1", "0"]])).unwrap_err();
        assert_eq!(narrow.code, DbErrorCode::Protocol);
    }

    #[test]
    fn error_messages_are_english_and_quote_a_short_excerpt() {
        let long = "x".repeat(1000);
        let error = parse(DbDriver::Postgres, &columns(&["QUERY PLAN"]), &json_rows(&long)).unwrap_err();
        assert!(error.message.is_ascii(), "{}", error.message);
        assert!(error.message.len() < 400, "{}", error.message);
    }
}
