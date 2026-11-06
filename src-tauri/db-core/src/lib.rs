//! The database engine behind the data-source pages.
//!
//! Ported from the `ide-db` crate of the reference project (`openidea`,
//! Apache-2.0) — see `UPSTREAM.md` for what was carried over and what was not.
//! The crate owns no Tauri state of its own: the app crate resolves
//! [`paths::DATA_DIR`] once at startup and calls into [`DbManager`].
//!
//! Catalog queries are pure functions in [`sql`]; the model they fill lives in
//! [`objects`], and [`DbManager`] runs them against a live pool.

pub mod conn;
pub mod error;
pub mod history;
pub mod manager;
pub mod objects;
pub mod paths;
pub mod secrets;
pub mod source;
pub mod split;
pub mod sql;

pub use conn::{Pool, QueryResult, ResultColumn};
pub use error::{DbError, DbErrorCode, DbResult};
pub use history::HistoryEntry;
pub use manager::{split_target, DbManager};
pub use objects::{
    ColumnInfo, Databases, DbObjectKind, DbTableKind, ForeignKey, IndexInfo, RoutineInfo, SchemaObjects,
    SequenceInfo, TableDetails, TableInfo, TriggerInfo,
};
pub use source::{DataSource, DbDriver};
