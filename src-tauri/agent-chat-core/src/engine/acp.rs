//! ACP driver.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 stub: B3 fills initialize, session/new|resume, set_model, prompt,
//! session/update projection and teardown.

/// Owns one ACP session. B3 replaces the empty definition with the real
/// driver.
pub struct AcpDriver;
