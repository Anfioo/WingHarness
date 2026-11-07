//! CLI location.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 always answers `None`, so every engine reports `available: false`; B1
//! implements PATH / PATHEXT / npm-prefix lookup and `.cmd` shims with `std`.

use std::path::PathBuf;

/// Locate the CLI binary named `name`.
///
/// A0 stub: the pickers must render the "not installed" state until B1 fills
/// the real probe.
pub fn find_cli_binary(_name: &str) -> Option<PathBuf> {
    None
}
