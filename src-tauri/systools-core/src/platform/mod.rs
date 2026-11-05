//! Platform contracts, the elevation broker, and Windows helper entry points.
//!
//! Every privileged operation is dispatched from `crate::helper::run_from_args`
//! before Tauri or a WebView is constructed.

pub mod contracts;
pub mod elevation;
pub(crate) mod file_icon;
pub(crate) mod startup_helper;
pub(crate) mod system_settings_helper;
pub(crate) mod windows;
