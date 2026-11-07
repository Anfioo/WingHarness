//! The files a data source window works on: the `.sql` files of the query
//! directory, the tab set of every window, and the row limits.
//!
//! Every file lives below the same `db` directory [`crate::manager::DbManager`]
//! is given, so a workspace and a connection never disagree about where the
//! data is. The type is a stub for now: the signatures are frozen for the
//! implementation that follows.

use std::path::PathBuf;

use crate::error::{DbError, DbResult};
use crate::models::{DbSettings, QueryFile, WindowTabs};

/// The query directory, the window tab records and the settings of one data
/// directory.
pub struct Workspace {
    #[allow(dead_code)]
    data_dir: PathBuf,
}

impl Workspace {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    /// The `.sql` files of the query directory, newest first.
    pub fn queries(&self) -> DbResult<Vec<QueryFile>> {
        Err(DbError::internal("not implemented"))
    }

    pub fn read_query(&self, name: &str) -> DbResult<String> {
        let _ = name;
        Err(DbError::internal("not implemented"))
    }

    pub fn write_query(&self, name: &str, text: &str) -> DbResult<()> {
        let _ = (name, text);
        Err(DbError::internal("not implemented"))
    }

    pub fn delete_query(&self, name: &str) -> DbResult<()> {
        let _ = name;
        Err(DbError::internal("not implemented"))
    }

    /// The stored tabs of `source`, or `None` when the window never saved any.
    pub fn window_tabs(&self, source: &str) -> DbResult<Option<WindowTabs>> {
        let _ = source;
        Err(DbError::internal("not implemented"))
    }

    pub fn save_window_tabs(&self, state: WindowTabs) -> DbResult<()> {
        let _ = state;
        Err(DbError::internal("not implemented"))
    }

    pub fn settings(&self) -> DbResult<DbSettings> {
        Err(DbError::internal("not implemented"))
    }

    pub fn save_settings(&self, settings: DbSettings) -> DbResult<()> {
        let _ = settings;
        Err(DbError::internal("not implemented"))
    }
}
