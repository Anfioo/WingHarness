//! The SVN working-copy engine.
//!
//! Ported wholesale from OrcaSVN (MIT), which — like this crate — implements no
//! part of the SVN protocol: it spawns the local `svn` executable, parses its
//! XML and text output, and keeps a disk snapshot of the working copy so status
//! does not have to be recomputed from scratch on every refresh.
//!
//! Copyright (c) 2026 VoidOrca. See `UPSTREAM.md` for the porting record.
//!
//! The root crate owns nothing here; it only registers [`commands`] and hands
//! over the data directory at startup.

pub mod commands;
pub mod error;
pub mod executor;
pub mod gitignore;
pub mod models;
pub mod operations;
pub mod parser;
pub mod proc;
pub mod status_cache;
pub mod status_snapshot;
pub mod status_usn;
pub mod store;
pub mod unversioned;
pub mod workspace_open;

pub use error::{SvnError, SvnResult};
pub use models::*;

/// Re-exports for the integration tests, mirroring `git-core`'s own `test_api`.
pub mod test_api {
    pub use crate::error::{SvnError, SvnResult};
    pub use crate::executor::{configure_svn_executable, execute_svn, SVN_TIMEOUT};
    pub use crate::models::{
        BlameLine, CommandResult, DiffResult, GitignoreData, OpenTarget, StashUnversionedEntry,
        SvnAuthUser, SvnInfo, SvnLogEntry, SvnLogPath, SvnStatus,
    };
    pub use crate::operations::{
        add, apply_patch, blame, checkout, cleanup, commit, current_user, delete, diff, info,
        local_revision, log, merge, remote_info, resolve, revert, status as svn_status, switch_cmd,
        update,
    };
    pub use crate::parser::{parse_blame_text, parse_info_xml, parse_log_xml, parse_status_xml};
    pub use crate::status_cache::cached_status;
    pub use crate::store::{cache_dir, dir, read_json, remove_file, write_json, RecentWorkspace, CONFIG_DIR};
    pub use crate::{gitignore, unversioned};

    /// The disk-status snapshot's capture/read/write are `pub(crate)`; these thin
    /// wrappers let `tests/status_snapshot.rs` exercise the write/read round trip
    /// without widening the crate's public surface. They name no private type.
    pub fn snapshot_write(
        directory: &std::path::Path,
        root: &std::path::Path,
    ) -> std::io::Result<()> {
        let inventory = crate::status_snapshot::capture(root)?;
        crate::status_snapshot::write(directory, root, inventory, Vec::new())
    }

    /// Whether `directory` holds a snapshot [`crate::status_snapshot::read`]
    /// accepts for `root` (version, root, index and freshness all agree).
    pub fn snapshot_read(directory: &std::path::Path, root: &std::path::Path) -> bool {
        crate::status_snapshot::read(directory, root).is_some()
    }
}
