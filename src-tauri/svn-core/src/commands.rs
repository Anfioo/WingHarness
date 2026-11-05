//! The Tauri command surface.
//!
//! Thirty-three commands, one per thing the UI can ask the engine to do. Every command
//! is a thin adapter: it names the payload, calls into the engine module that
//! owns the behaviour, and stringifies the error for the frontend (which shows
//! it verbatim). No command contains logic of its own.

use crate::error::SvnError;
use crate::executor;
use crate::models::{
    CommandResult, DiffResult, GitignoreData, OpenTarget, SvnAuthUser, SvnInfo, SvnLogEntry,
    SvnStatus, StashUnversionedEntry,
};
use crate::{gitignore, operations, status_cache, store, unversioned, workspace_open};

/// Stringify an engine error for the Tauri boundary.
fn report<T>(result: Result<T, SvnError>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

// -- Environment ------------------------------------------------------------

/// Point the engine at a user-chosen `svn` binary and report its version.
#[tauri::command]
pub async fn configure_svn_executable(executable: Option<String>) -> Result<String, String> {
    report(executor::configure_svn_executable(executable.as_deref()).await)
}

// -- Checkout, update and the other working-copy-wide operations -------------

/// `svn checkout`, optionally at a pinned revision.
#[tauri::command]
pub async fn svn_checkout(
    url: String,
    path: String,
    revision: Option<u64>,
) -> Result<CommandResult, String> {
    match operations::checkout(&url, &path, revision).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// `svn update`, optionally to a pinned revision.
#[tauri::command]
pub async fn svn_update(path: String, revision: Option<u64>) -> Result<CommandResult, String> {
    match operations::update(&path, revision).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// `svn switch` the working copy to another URL.
#[tauri::command]
pub async fn svn_switch(path: String, url: String) -> Result<CommandResult, String> {
    match operations::switch_cmd(&path, &url).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// `svn merge -r start:end source` inside the working copy.
#[tauri::command]
pub async fn svn_merge(
    path: String,
    source: String,
    rev_start: u64,
    rev_end: u64,
) -> Result<CommandResult, String> {
    match operations::merge(&path, &source, rev_start, rev_end).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// `svn cleanup` — clear a stale lock so the working copy is usable again.
#[tauri::command]
pub async fn svn_cleanup(path: String) -> Result<CommandResult, String> {
    match operations::cleanup(&path).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

// -- Status -----------------------------------------------------------------

/// The working copy's status, served from the incremental cache when possible.
/// `force` bypasses the cache and rescans from disk.
#[tauri::command]
pub async fn svn_status(path: String, force: Option<bool>) -> Result<Vec<SvnStatus>, String> {
    let cache_dir = store::cache_dir().ok();
    report(status_cache::cached_status(&path, force.unwrap_or(false), cache_dir).await)
}

// -- Commit -----------------------------------------------------------------

/// `svn commit` the given paths (or the whole working copy when none are given).
#[tauri::command]
pub async fn svn_commit(
    path: String,
    message: String,
    files: Option<Vec<String>>,
) -> Result<CommandResult, String> {
    match operations::commit(&path, &message, files.as_deref()).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

// -- Per-path working-copy operations ---------------------------------------

/// `svn add` the given paths.
#[tauri::command]
pub async fn svn_add(path: String, files: Vec<String>) -> Result<CommandResult, String> {
    match operations::add(&path, &files).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// `svn delete` the given paths.
#[tauri::command]
pub async fn svn_delete(path: String, files: Vec<String>) -> Result<CommandResult, String> {
    match operations::delete(&path, &files).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// `svn revert` the given paths.
#[tauri::command]
pub async fn svn_revert(path: String, files: Vec<String>) -> Result<CommandResult, String> {
    match operations::revert(&path, &files).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// `svn resolve --accept <strategy>` the given conflicted paths.
#[tauri::command]
pub async fn svn_resolve(
    path: String,
    files: Vec<String>,
    strategy: String,
) -> Result<CommandResult, String> {
    match operations::resolve(&path, &files, &strategy).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

/// Apply a unified diff (a stash patch) to the working copy.
#[tauri::command]
pub async fn svn_apply_patch(
    workspace_path: String,
    patch: String,
    reverse: bool,
) -> Result<CommandResult, String> {
    match operations::apply_patch(&workspace_path, &patch, reverse).await {
        Ok(output) => Ok(CommandResult::ok(output)),
        Err(error) => Err(error.to_string()),
    }
}

// -- History and queries ----------------------------------------------------

/// `svn log`, with optional revision range, keyword, author and date filters.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn svn_log(
    path: String,
    limit: Option<u32>,
    start_rev: Option<u64>,
    end_rev: Option<u64>,
    keyword: Option<String>,
    author: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
) -> Result<Vec<SvnLogEntry>, String> {
    report(
        operations::log(
            &path,
            limit,
            start_rev,
            end_rev,
            keyword.as_deref(),
            author.as_deref(),
            date_from.as_deref(),
            date_to.as_deref(),
        )
        .await,
    )
}

/// A single file's diff, against the base revision or between two revisions.
#[tauri::command]
pub async fn svn_diff(
    workspace_path: String,
    file: String,
    old_rev: Option<u64>,
    new_rev: Option<u64>,
) -> Result<DiffResult, String> {
    report(operations::diff(&workspace_path, &file, old_rev, new_rev).await)
}

/// Per-line attribution for a file.
#[tauri::command]
pub async fn svn_blame(
    workspace_path: String,
    file: String,
) -> Result<Vec<crate::models::BlameLine>, String> {
    report(operations::blame(&workspace_path, &file).await)
}

/// `svn info` for the working copy.
#[tauri::command]
pub async fn svn_info(path: String) -> Result<SvnInfo, String> {
    report(operations::info(&path).await)
}

/// `svn info` against the repository, so the UI can show how far behind the
/// working copy is without updating it.
#[tauri::command]
pub async fn svn_remote_info(path: String) -> Result<SvnInfo, String> {
    report(operations::remote_info(&path).await)
}

/// The credential `svn` would use for this working copy, when it knows one.
#[tauri::command]
pub async fn svn_current_user(path: String) -> Result<Option<SvnAuthUser>, String> {
    report(operations::current_user(&path).await)
}

/// The working copy's own revision — what the header shows.
#[tauri::command]
pub async fn svn_local_revision(path: String) -> Result<u64, String> {
    report(operations::local_revision(&path).await)
}

// -- Unversioned files ------------------------------------------------------

/// Delete unversioned paths from the working copy.
#[tauri::command]
pub async fn delete_unversioned(path: String, files: Vec<String>) -> Result<CommandResult, String> {
    report(unversioned::delete(&path, &files))
}

/// Capture unversioned paths (base64) so they can be stashed.
#[tauri::command]
pub async fn read_unversioned_files(
    path: String,
    files: Vec<String>,
) -> Result<Vec<StashUnversionedEntry>, String> {
    report(unversioned::read(&path, &files).await)
}

/// Write stashed unversioned paths back. `dry_run` validates without touching
/// the disk, which is what the confirmation dialog asks for first.
#[tauri::command]
pub async fn restore_unversioned_files(
    path: String,
    files: Vec<StashUnversionedEntry>,
    dry_run: bool,
) -> Result<(), String> {
    report(unversioned::restore(&path, &files, dry_run))
}

// -- Opening a working copy elsewhere ---------------------------------------

/// Open the working copy in Explorer, VS Code or a terminal.
#[tauri::command]
pub async fn open_workspace_target(path: String, target: OpenTarget) -> Result<(), String> {
    report(workspace_open::open_target(&path, target).await)
}

/// Reveal one file inside the working copy in Explorer.
#[tauri::command]
pub async fn reveal_workspace_file(path: String, file: String) -> Result<(), String> {
    report(workspace_open::reveal(&path, &file).await)
}

// -- Ignore rules -----------------------------------------------------------

/// The working copy's `.gitignore`, or `None` when it has none. The UI does the
/// matching; this command only reads.
#[tauri::command]
pub async fn read_gitignore(path: String) -> Result<Option<GitignoreData>, String> {
    report(gitignore::read(&path))
}

// -- Recent working copies (the feature's own persistence) -------------------

/// The recently opened working copies, most recent first.
#[tauri::command]
pub async fn svn_workspace_recent() -> Result<Vec<store::RecentWorkspace>, String> {
    report(store::recent())
}

/// Record that a working copy was opened, bumping it to the top of the list.
#[tauri::command]
pub async fn svn_workspace_remember(
    path: String,
    revision: Option<u64>,
) -> Result<Vec<store::RecentWorkspace>, String> {
    report(store::remember(&path, revision))
}

/// Drop a working copy from the recent list.
#[tauri::command]
pub async fn svn_workspace_forget(path: String) -> Result<Vec<store::RecentWorkspace>, String> {
    report(store::forget(&path))
}

/// Write a stash export to a path the user picked in the save dialog. The
/// frontend never touches the filesystem itself.
#[tauri::command]
pub async fn svn_stash_export(path: String, contents: String) -> Result<(), String> {
    report(store::export_stash(&path, &contents))
}

// -- Raw key/value store (the frontend's own persisted state) -----------------

/// Read a raw value from the feature's data directory, or `None` when the key
/// has never been written. Mirrors `git-core`'s `git_store_*` trio: the frontend
/// uses it as a zustand `StateStorage`, one file per key.
#[tauri::command]
pub async fn svn_store_read(key: String) -> Result<Option<String>, String> {
    report(store::read(&key))
}

/// Write a raw value to the feature's data directory.
#[tauri::command]
pub async fn svn_store_write(key: String, value: String) -> Result<(), String> {
    report(store::write(&key, &value))
}

/// Delete a key from the feature's data directory. A missing key is not an
/// error.
#[tauri::command]
pub async fn svn_store_remove(key: String) -> Result<(), String> {
    report(store::remove(&key))
}
