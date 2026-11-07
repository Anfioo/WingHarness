//! Qoder engine declaration (ACP, Own transport).
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! `qodercli --acp` speaks the Agent Client Protocol (JSON-RPC over stdio)
//! and stays resident across requests, so the engine drives its own transport
//! ([`Engine::drives_own_transport`]). One send spawns one child inside
//! [`super::acp::run_acp_turn`], which owns the handshake and the projection
//! of `session/update` notifications.

use std::path::Path;

use crate::engine::events::EngineEvent;
use crate::engine::{BuiltCommand, Engine, SendRequest};

/// Qoder ships two distributions with independent binaries and config homes:
/// Global (`qodercli`, `~/.qoder`) and CN (`qoderclicn`, `~/.qoder-cn`). Each
/// is a sibling engine id sharing the one ACP driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QoderDistribution {
    Global,
    Cn,
}

impl QoderDistribution {
    pub fn engine_id(self) -> &'static str {
        match self {
            Self::Global => "qoder",
            Self::Cn => "qoder-cn",
        }
    }

    /// The binary behind the engine id. The `qoder` binary is the IDE
    /// launcher and speaks no ACP.
    pub fn cli_name(self) -> &'static str {
        match self {
            Self::Global => "qodercli",
            Self::Cn => "qoderclicn",
        }
    }

    /// Default config/session home owned by the CLI itself.
    pub fn default_config_dir_name(self) -> &'static str {
        match self {
            Self::Global => ".qoder",
            Self::Cn => ".qoder-cn",
        }
    }
}

/// Qoder over ACP.
///
/// Only the Global distribution is registered in `engine_by_id` for now; this
/// is a unit type because that registry constructs it without arguments. The
/// CN distribution shares the same driver, so wiring it later means adding
/// `"qoder-cn" => QoderEngine::new(QoderDistribution::Cn)` there.
pub struct QoderEngine;

impl QoderEngine {
    pub fn new(distribution: QoderDistribution) -> Self {
        let _ = distribution;
        Self
    }
}

impl Engine for QoderEngine {
    fn id(&self) -> &'static str {
        QoderDistribution::Global.engine_id()
    }

    /// Never invoked: `send` branches on `drives_own_transport` before any
    /// child is built.
    fn build_command(
        &self,
        _req: &SendRequest,
        _bin: &str,
    ) -> Result<BuiltCommand, crate::error::AgentChatError> {
        Err(crate::error::AgentChatError::unsupported(
            "Qoder runs as an ACP host session; there is no child command to build.",
        ))
    }

    /// ACP frames are JSON-RPC parsed by the turn driver, not line-mapped.
    fn parse_line(&self, _line: &str, _out: &mut Vec<EngineEvent>) {}

    fn drives_own_transport(&self) -> bool {
        true
    }

    fn supports_effort(&self) -> bool {
        true
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        // A headless ACP turn cannot honor an approval flow: the driver always
        // starts the session in bypass mode, and any permission request that
        // still arrives is auto-allowed. Only "bypass" is honest.
        &["bypass"]
    }
}

/// File stem of a bin path, lowercased (`/usr/local/bin/qodercli` → `qodercli`).
fn binary_file_stem(bin: &str) -> String {
    Path::new(bin.trim())
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(bin.trim())
        .to_ascii_lowercase()
}

/// The Qoder IDE launcher is also called `qoder` but speaks no ACP; only the
/// CLI (`qodercli`) works as an engine bin.
pub(crate) fn is_qoder_ide_launcher_bin(bin: &str) -> bool {
    binary_file_stem(bin) == "qoder"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distributions_carry_independent_identities() {
        assert_eq!(QoderDistribution::Global.engine_id(), "qoder");
        assert_eq!(QoderDistribution::Cn.engine_id(), "qoder-cn");
        assert_eq!(QoderDistribution::Global.cli_name(), "qodercli");
        assert_eq!(QoderDistribution::Cn.cli_name(), "qoderclicn");
        assert_eq!(
            QoderDistribution::Global.default_config_dir_name(),
            ".qoder"
        );
        assert_eq!(QoderDistribution::Cn.default_config_dir_name(), ".qoder-cn");
    }

    #[test]
    fn the_engine_reports_the_bypass_only_permission_set() {
        let engine = QoderEngine::new(QoderDistribution::Global);
        assert_eq!(engine.id(), "qoder");
        assert!(engine.drives_own_transport());
        assert!(engine.supports_effort());
        assert_eq!(engine.supported_permissions(), &["bypass"]);
    }

    #[test]
    fn ide_launcher_stem_is_rejected() {
        assert!(is_qoder_ide_launcher_bin("/Applications/Qoder.app/qoder"));
        assert!(is_qoder_ide_launcher_bin("qoder"));
        assert!(is_qoder_ide_launcher_bin("C:\\Qoder\\Qoder.exe"));
        assert!(!is_qoder_ide_launcher_bin("/usr/local/bin/qodercli"));
        assert!(!is_qoder_ide_launcher_bin("qodercli"));
        assert!(!is_qoder_ide_launcher_bin("C:\\npm\\qodercli.cmd"));
    }
}
