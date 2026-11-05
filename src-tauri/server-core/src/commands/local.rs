//! Local filesystem commands for the left pane.

use crate::error::{ServerError, ServerResult};
use crate::local_fs;
use crate::models::SftpEntry;

fn require_path(path: &str) -> ServerResult<&str> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(ServerError::path_invalid(path));
    }
    Ok(path)
}

pub(crate) async fn home() -> ServerResult<String> {
    local_fs::home()
}

pub(crate) async fn list(path: &str, show_hidden: bool) -> ServerResult<Vec<SftpEntry>> {
    require_path(path)?;
    local_fs::list(path, show_hidden)
}

pub(crate) async fn mkdir(path: &str) -> ServerResult<()> {
    require_path(path)?;
    local_fs::mkdir(path)
}

pub(crate) async fn rename(from: &str, to: &str) -> ServerResult<()> {
    require_path(from)?;
    require_path(to)?;
    local_fs::rename(from, to)
}

pub(crate) async fn delete(path: &str, is_dir: bool) -> ServerResult<()> {
    require_path(path)?;
    local_fs::delete(path, is_dir)
}
