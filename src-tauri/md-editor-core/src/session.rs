//! `session.json`: the tabs, carets and view modes to restore on next launch.
//!
//! Untitled documents are never written here; only files with a path survive a
//! restart, so the data directory never collects stray drafts.

use crate::error::MdEditorResult;
use crate::models::MdSession;
use crate::paths;
use crate::store::{load_json, save_json};

/// More tabs than this are not worth restoring; the list is truncated.
pub const MAX_SESSION_TABS: usize = 50;

/// Read the last session, capped at [`MAX_SESSION_TABS`].
pub fn get() -> MdEditorResult<MdSession> {
    let path = paths::session_path()?;
    let mut session = load_json::<MdSession>(&path);
    session.tabs.truncate(MAX_SESSION_TABS);
    Ok(session)
}

/// Persist the session, dropping tabs that have no path.
pub fn set(session: &MdSession) -> MdEditorResult<()> {
    let path = paths::session_path()?;

    let tabs: Vec<_> = session
        .tabs
        .iter()
        .filter(|tab| !tab.path.trim().is_empty())
        .take(MAX_SESSION_TABS)
        .cloned()
        .collect();
    let active_path = session
        .active_path
        .as_ref()
        .filter(|path| !path.trim().is_empty())
        .cloned();

    save_json(
        &path,
        &MdSession {
            tabs,
            active_path,
        },
    )
}
