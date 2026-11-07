//! Codex adapter (Own transport, app-server).
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 stub: B2 fills `host_command` and the app-server driver; there is no
//! `codex exec` fallback by decision D11.

use crate::engine::{events, BuiltCommand, Engine, SendRequest};

pub struct CodexEngine;

impl Engine for CodexEngine {
    fn id(&self) -> &'static str {
        "codex"
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
        &["auto", "manual", "bypass", "plan"]
    }
}
