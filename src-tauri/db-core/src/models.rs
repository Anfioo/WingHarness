//! The wire model of the table editor and the multi-statement console: sort
//! keys, cell edits, table pages, the completion catalog and one statement's
//! outcome.
//!
//! Ported from the model types at the top of `ide_db`'s `lib.rs` (Apache-2.0).
//! Every struct keeps `#[serde(rename_all = "camelCase")]`, and [`DbRowEdit`]
//! is tagged by `kind` so the frontend can send updates, inserts and deletes in
//! one list.

use serde::{Deserialize, Serialize};

use crate::conn::QueryResult;
use crate::error::DbError;
use crate::objects::{DbTableKind, ForeignKey, TableDetails};
use crate::split::SqlStatement;

/// One `ORDER BY` term of a table page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: String,
    pub descending: bool,
}

/// One column of a row edit: the value to write, or part of the key that
/// locates the row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    pub column: String,
    /// `None` is SQL NULL.
    pub value: Option<String>,
}

/// One pending change of a table editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbRowEdit {
    Update { key: Vec<CellValue>, values: Vec<CellValue> },
    Insert { values: Vec<CellValue> },
    Delete { key: Vec<CellValue> },
}

/// One page of a table, with the metadata the editor renders it from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub result: QueryResult,
    pub details: TableDetails,
    pub offset: f64,
}

/// One column of the completion model; `has_default` distinguishes a column
/// that may be left out of an `INSERT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub has_default: bool,
}

/// One relation of the completion model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionTable {
    pub schema: String,
    pub name: String,
    pub kind: DbTableKind,
    pub columns: Vec<CompletionColumn>,
}

/// Everything the editor's completion source needs, fetched once per
/// connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionModel {
    pub default_schema: String,
    pub tables: Vec<CompletionTable>,
    pub foreign_keys: Vec<ForeignKey>,
}

/// What one statement of a batch produced. `error` is set instead of failing
/// the whole call, so earlier statements keep their results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    pub statement: SqlStatement,
    pub result: Option<QueryResult>,
    pub error: Option<DbError>,
}
