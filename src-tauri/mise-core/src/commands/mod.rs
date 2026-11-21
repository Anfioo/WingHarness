// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Thin `#[tauri::command]` layers over the domain modules. The function names
//! here are the command names in `invoke.rs` and `build.rs`.

pub mod config;
pub mod dashboard;
pub mod history;
pub mod projects;
pub mod runtime;
pub mod tools;

pub use config::{mise_config_preview_edit, mise_config_save, mise_config_workspace};
pub use dashboard::mise_dashboard;
pub use history::{mise_history_list, mise_history_record_canceled};
pub use projects::{
    mise_projects_scan, mise_scan_dirs_add, mise_scan_dirs_list, mise_scan_dirs_remove,
    mise_scan_dirs_set_enabled,
};
pub use runtime::mise_runtime_info;
pub use tools::{
    mise_action_run, mise_tool_detail, mise_tool_detail_cancel, mise_tools_list,
};
