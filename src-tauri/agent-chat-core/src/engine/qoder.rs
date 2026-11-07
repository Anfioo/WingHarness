//! Qoder engine declaration (ACP, Own transport).
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 stub: B3 fills the ACP launch. Only the Global distribution is
//! registered; `qoder-cn` shares the same driver.

use crate::engine::{events, BuiltCommand, Engine, SendRequest};

pub struct QoderEngine;

impl Engine for QoderEngine {
    fn id(&self) -> &'static str {
        "qoder"
    }

    fn build_command(
        &self,
        _req: &SendRequest,
        _bin: &str,
    ) -> Result<BuiltCommand, crate::error::AgentChatError> {
        Err(crate::error::AgentChatError::not_implemented())
    }

    fn parse_line(&self, _line: &str, _out: &mut Vec<events::EngineEvent>) {}

    fn drives_own_transport(&self) -> bool {
        true
    }

    fn supports_effort(&self) -> bool {
        true
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        // A headless ACP turn cannot honor an approval flow; only bypass is
        // honest.
        &["bypass"]
    }
}
