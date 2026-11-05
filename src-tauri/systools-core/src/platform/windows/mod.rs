//! Windows-specific privileged adapters.
//!
//! Only the entry points the elevation broker dispatches to live here. Every
//! module validates its own arguments before touching the operating system.

pub(crate) mod application_restart;
mod change_tracking;
pub(crate) mod child_process;
mod directory_aggregate;
mod directory_entry;
mod directory_identity;
mod directories;
mod file_space;
pub(crate) mod file_layout;
pub(crate) mod kernel;
pub(crate) mod large_files;
pub(crate) mod native_io;
mod path_identity;
mod volumes;
mod allocated_content;
pub(crate) mod file_version;
pub(crate) mod inventory;
pub mod native_uninstall;
pub(crate) mod package_evidence;
pub(crate) mod package_locations;
pub(crate) mod package_reconciliation;
pub(crate) mod package_sources;
pub(crate) mod process_control;
pub(crate) mod registration_removal;
pub(crate) mod shortcut_name;
pub(crate) mod shortcut_overlay;
pub(crate) mod startup;
pub(crate) mod system_settings;

pub(crate) use kernel::{
    is_remote_placeholder_attributes, WindowsPlatform, FILE_ATTRIBUTE_REPARSE_POINT_VALUE,
};
pub use kernel::windows_file_attributes_are_link_like;
pub(crate) use native_uninstall::launch_privileged_uninstaller;
