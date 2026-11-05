//! Remote directory and file commands over the SFTP subsystem.

use crate::error::{ServerError, ServerResult};
use crate::models::SftpEntry;
use crate::sftp::ops::TEXT_LIMIT;
use crate::ServerState;

fn require_profile(profile_id: &str) -> ServerResult<()> {
    if profile_id.trim().is_empty() {
        return Err(ServerError::internal("A profile id is required."));
    }
    Ok(())
}

fn require_path(path: &str) -> ServerResult<&str> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(ServerError::path_invalid(path));
    }
    Ok(path)
}

pub(crate) async fn home(state: &ServerState, profile_id: &str) -> ServerResult<String> {
    require_profile(profile_id)?;
    state.connections.sftp(profile_id).await?.home().await
}

pub(crate) async fn list(
    state: &ServerState,
    profile_id: &str,
    path: &str,
) -> ServerResult<Vec<SftpEntry>> {
    require_profile(profile_id)?;
    require_path(path)?;
    state.connections.sftp(profile_id).await?.list(path).await
}

pub(crate) async fn stat(
    state: &ServerState,
    profile_id: &str,
    path: &str,
) -> ServerResult<SftpEntry> {
    require_profile(profile_id)?;
    require_path(path)?;
    state.connections.sftp(profile_id).await?.stat(path).await
}

pub(crate) async fn mkdir(
    state: &ServerState,
    profile_id: &str,
    path: &str,
) -> ServerResult<()> {
    require_profile(profile_id)?;
    require_path(path)?;
    state
        .connections
        .sftp(profile_id)
        .await?
        .mkdir(path)
        .await
}

pub(crate) async fn rename(
    state: &ServerState,
    profile_id: &str,
    from: &str,
    to: &str,
) -> ServerResult<()> {
    require_profile(profile_id)?;
    require_path(from)?;
    require_path(to)?;
    state
        .connections
        .sftp(profile_id)
        .await?
        .rename(from, to)
        .await
}

pub(crate) async fn delete(
    state: &ServerState,
    profile_id: &str,
    path: &str,
    is_dir: bool,
) -> ServerResult<()> {
    require_profile(profile_id)?;
    require_path(path)?;
    state
        .connections
        .sftp(profile_id)
        .await?
        .remove(path, is_dir)
        .await
}

pub(crate) async fn read_text(
    state: &ServerState,
    profile_id: &str,
    path: &str,
) -> ServerResult<String> {
    require_profile(profile_id)?;
    require_path(path)?;

    let bytes = state
        .connections
        .sftp(profile_id)
        .await?
        .read_file(path, TEXT_LIMIT)
        .await?;

    String::from_utf8(bytes)
        .map_err(|_| ServerError::internal("The remote file is not valid UTF-8."))
}

pub(crate) async fn write_text(
    state: &ServerState,
    profile_id: &str,
    path: &str,
    content: &str,
) -> ServerResult<()> {
    require_profile(profile_id)?;
    require_path(path)?;

    let size = content.len() as u64;
    if size > TEXT_LIMIT {
        return Err(ServerError::file_too_large(size, TEXT_LIMIT));
    }

    state
        .connections
        .sftp(profile_id)
        .await?
        .write_file(path, content.as_bytes())
        .await
}
