//! Git engine for the standalone repository window.
//!
//! Adapted from angkorgit (MIT), https://github.com/cheat2001/angkorgit.
//! Copyright (c) 2026 Chansocheat Sok and AngKorGit contributors.
//! See `UPSTREAM.md` for the porting record.

#![allow(non_snake_case)]

pub mod account_check;
pub mod accounts;
pub mod ai_cli;
pub mod ai_keys;
pub mod blame;
pub mod branch;
pub mod commands;
pub mod commit;
pub mod conflict;
pub mod diff;
pub mod editors;
pub mod engine_info;
pub mod error;
pub mod files;
pub mod fonts;
pub mod forge;
pub mod history;
pub mod http;
pub mod misc;
pub mod proc;
pub mod remote;
pub mod repo;
pub mod scan;
pub mod sign;
pub mod stage;
pub mod state;
pub mod store;
pub mod terminal;
pub mod types;
pub mod watcher;
pub mod worktree;

pub mod test_api {
    pub use crate::blame::blame_file;
    pub use crate::branch::{
        can_fast_forward, checkout_branch, cherry_pick, cherry_pick_many, cherry_pick_paths,
        create as branch_create, list as branches, merge, rebase, rebase_commits,
        rebase_interactive, reset, revert_paths,
    };
    pub use crate::commit::{
        amend, commit, drop_paths, extract_paths, is_ancestor as commit_is_ancestor, merge_message,
        revert, reword,
    };
    pub use crate::conflict::{list as conflict_list, read as conflict_read, resolve as conflict_resolve};
    pub use crate::diff::{
        commit_diff_with, commit_file_diff, commit_file_diff_with, commit_files, file_diff,
        file_diff_with,
    };
    pub use crate::files::{file_contents, index_files, tree_files};
    pub use crate::history::{
        file_history, list as history, position as history_position, search as history_search,
        unpushed,
    };
    pub use crate::misc::{
        stash_create, stash_files, stash_list, stash_pop, stash_restore_files, tag_create,
        tag_delete, tag_list,
    };
    pub use crate::remote::{
        add as remote_add, checkout_remote_ref, fetch, list as remote_list, pull, push,
    };
    pub use crate::repo::{
        cleanup_state, discover, info as repo_info, init, ref_fingerprint, set_config, status,
    };
    pub use crate::scan::{scan as scan_repositories, SCAN_MAX_DEPTH};
    pub use crate::stage::{
        discard_all, discard_file, discard_line, discard_staged_all, discard_staged_file,
        restore_from_rev, stage_all, stage_file, stage_hunk, stage_line, unstage_all,
        unstage_file, unstage_hunk, unstage_line,
    };
    pub use crate::types::HistoryQuery;
    pub use crate::types::HistorySearchQuery;
    pub use crate::types::RebaseTodoEntry;
    pub use crate::types::WorktreeAddRequest;
    pub use crate::worktree::{
        add as worktree_add, list as worktree_list, prune as worktree_prune,
        remove as worktree_remove,
    };
}

pub use engine_info::git_engine_info;