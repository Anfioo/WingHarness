//! The execution plan of a statement, normalised to one tree the frontend
//! renders whatever the driver's `EXPLAIN` output looks like.
//!
//! A stub for now: the signatures are frozen for the implementation that
//! follows.

use crate::error::{DbError, DbResult};
use crate::models::PlanNode;
use crate::source::DbDriver;

/// The statement to send to the server to obtain a plan.
pub fn explain_statement(_driver: DbDriver, statement: &str) -> String {
    format!("EXPLAIN {statement}")
}

/// The plan tree of one `EXPLAIN` result set.
pub fn parse(_driver: DbDriver, _columns: &[String], _rows: &[Vec<Option<String>>]) -> DbResult<Vec<PlanNode>> {
    Err(DbError::internal("not implemented"))
}
