//! The introspection model the commands return: databases, schemas, tables,
//! columns, indexes, foreign keys, triggers, routines and sequences.
//!
//! Ported from the model types at the top of `ide_db`'s `lib.rs` (Apache-2.0).
//! `specta::Type` is gone; every struct keeps `#[serde(rename_all = "camelCase")]`
//! so the wire format is unchanged.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbTableKind {
    Table,
    View,
    MaterializedView,
}

impl DbTableKind {
    pub(crate) fn from_catalog(kind: Option<&str>) -> Self {
        match kind {
            Some("view") => Self::View,
            Some("materialized view") => Self::MaterializedView,
            _ => Self::Table,
        }
    }
}

/// Schema objects other than tables and columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbObjectKind {
    Function,
    Procedure,
    Trigger,
    Sequence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    /// `before`, `after`, `instead of`.
    pub timing: String,
    /// `insert`, `update or delete`…
    pub events: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    pub name: String,
    /// `Function` or `Procedure`.
    pub kind: DbObjectKind,
    pub arguments: String,
    /// Result type of a function.
    pub returns: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub name: String,
    pub data_type: String,
}

/// A schema's routines and sequences (the tree's `routines` / `sequences` folders).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjects {
    pub routines: Vec<RoutineInfo>,
    pub sequences: Vec<SequenceInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub kind: DbTableKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}

/// `schema.table (columns) REFERENCES ref_schema.ref_table (ref_columns)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKey>,
    pub triggers: Vec<TriggerInfo>,
}

/// The databases of a server, with the one the data source connects to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Databases {
    /// The database the data source connects to (its setting, or the server default).
    pub current: String,
    pub names: Vec<String>,
}

/// Catalog flags differ by driver: `YES`/`NO` (PostgreSQL, MySQL), `1`/`0` (SQLite).
pub(crate) fn flag(value: &Option<String>) -> bool {
    matches!(value.as_deref(), Some("1" | "t" | "true" | "YES"))
}

/// Groups foreign-key rows into keys by their constraint, in catalog order.
///
/// A missing referenced column (SQLite's implicit primary-key reference) is left
/// empty for the caller to resolve.
pub(crate) fn group_foreign_keys(rows: Vec<Vec<Option<String>>>) -> Vec<ForeignKey> {
    let mut keys: Vec<(String, ForeignKey)> = Vec::new();
    for row in rows {
        let mut cells = row.into_iter();
        let mut next = || cells.next().flatten();
        let (Some(schema), Some(table), Some(constraint), Some(column), ref_schema, Some(ref_table), ref_column) =
            (next(), next(), next(), next(), next(), next(), next())
        else {
            continue;
        };
        let ref_schema = ref_schema.unwrap_or_else(|| schema.clone());
        let same = |(name, key): &(String, ForeignKey)| {
            *name == constraint && key.schema == schema && key.table == table
        };
        if !keys.last().is_some_and(same) {
            keys.push((
                constraint.clone(),
                ForeignKey {
                    schema,
                    table,
                    columns: Vec::new(),
                    ref_schema,
                    ref_table,
                    ref_columns: Vec::new(),
                },
            ));
        }
        let key = &mut keys.last_mut().expect("pushed above").1;
        key.columns.push(column);
        key.ref_columns.extend(ref_column);
    }
    keys.into_iter().map(|(_, key)| key).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: [Option<&str>; 7]) -> Vec<Option<String>> {
        cells.iter().map(|cell| cell.map(str::to_owned)).collect()
    }

    #[test]
    fn groups_composite_foreign_keys_by_constraint() {
        let keys = group_foreign_keys(vec![
            row([Some("main"), Some("child"), Some("1"), Some("a"), Some("main"), Some("parent"), Some("x")]),
            row([Some("main"), Some("child"), Some("1"), Some("b"), Some("main"), Some("parent"), Some("y")]),
            // SQLite's implicit reference to the primary key: no target column.
            row([Some("main"), Some("other"), Some("2"), Some("ref"), Some("main"), Some("parent"), None]),
        ]);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].columns, ["a", "b"]);
        assert_eq!(keys[0].ref_columns, ["x", "y"]);
        assert!(keys[1].ref_columns.is_empty());
    }

    #[test]
    fn reads_catalog_flags() {
        for value in ["1", "t", "true", "YES"] {
            assert!(flag(&Some(value.into())), "{value}");
        }
        for value in ["0", "f", "false", "NO", "", "yes"] {
            assert!(!flag(&Some(value.into())), "{value}");
        }
        assert!(!flag(&None));
    }

    #[test]
    fn maps_catalog_kinds() {
        assert_eq!(DbTableKind::from_catalog(Some("view")), DbTableKind::View);
        assert_eq!(DbTableKind::from_catalog(Some("materialized view")), DbTableKind::MaterializedView);
        assert_eq!(DbTableKind::from_catalog(Some("table")), DbTableKind::Table);
        assert_eq!(DbTableKind::from_catalog(None), DbTableKind::Table);
    }
}
