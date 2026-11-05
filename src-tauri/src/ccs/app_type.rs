//! 支持的 AI 编程 CLI 工具定义。
//!
//! 每个变体携带一份静态元数据（可执行命令、默认配置目录、配置文件名、是否累加式、
//! 默认是否可见），供路径解析、版本检测、切换引擎和设置页统一使用。

use serde::{Deserialize, Serialize};

/// 支持的 AI 编程 CLI 应用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppType {
    /// Claude Code（Anthropic 官方 CLI）
    Claude,
    /// OpenAI Codex CLI
    Codex,
    /// Google Gemini CLI
    Gemini,
    /// xAI Grok Build CLI
    GrokBuild,
    /// OpenCode
    OpenCode,
    /// OpenClaw
    OpenClaw,
    /// Hermes
    Hermes,
    /// Pi
    Pi,
    /// MiniMax Code
    Mcode,
}

/// 应用的静态元数据。
#[derive(Debug, Clone, Copy)]
pub struct AppMeta {
    /// 稳定的字符串标识（与 serde 序列化结果一致）。
    pub id: &'static str,
    /// 版本检测时执行的命令名。
    pub command: &'static str,
    /// 相对用户主目录的默认配置目录。
    pub default_dir: &'static str,
    /// 主配置文件名（相对配置目录）。累加式或路径特殊的应用可能为 `None`。
    pub config_file: Option<&'static str>,
    /// 配置文件格式。
    pub format: ConfigFormat,
    /// 是否为累加式（多供应商共存）。
    pub additive: bool,
    /// 全新安装时是否默认在主页面可见。
    pub default_visible: bool,
}

/// 配置文件格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigFormat {
    Json,
    Toml,
    Yaml,
    Env,
}

impl AppType {
    /// 全部支持的应用，按主页面展示顺序排列。
    pub const ALL: [AppType; 9] = [
        AppType::Claude,
        AppType::Codex,
        AppType::Gemini,
        AppType::GrokBuild,
        AppType::OpenCode,
        AppType::OpenClaw,
        AppType::Hermes,
        AppType::Pi,
        AppType::Mcode,
    ];

    /// 返回该应用的静态元数据。
    pub fn meta(self) -> AppMeta {
        match self {
            AppType::Claude => AppMeta {
                id: "claude",
                command: "claude",
                default_dir: ".claude",
                config_file: Some("settings.json"),
                format: ConfigFormat::Json,
                additive: false,
                default_visible: true,
            },
            AppType::Codex => AppMeta {
                id: "codex",
                command: "codex",
                default_dir: ".codex",
                config_file: Some("config.toml"),
                format: ConfigFormat::Toml,
                additive: false,
                default_visible: true,
            },
            AppType::Gemini => AppMeta {
                id: "gemini",
                command: "gemini",
                default_dir: ".gemini",
                config_file: Some("settings.json"),
                format: ConfigFormat::Json,
                additive: false,
                default_visible: true,
            },
            AppType::GrokBuild => AppMeta {
                id: "grokbuild",
                command: "grok",
                default_dir: ".grok",
                config_file: Some("config.toml"),
                format: ConfigFormat::Toml,
                additive: false,
                default_visible: true,
            },
            AppType::OpenCode => AppMeta {
                id: "opencode",
                command: "opencode",
                default_dir: ".config/opencode",
                config_file: Some("opencode.json"),
                format: ConfigFormat::Json,
                additive: true,
                default_visible: true,
            },
            AppType::OpenClaw => AppMeta {
                id: "openclaw",
                command: "openclaw",
                default_dir: ".openclaw",
                config_file: Some("openclaw.json"),
                format: ConfigFormat::Json,
                additive: true,
                default_visible: false,
            },
            AppType::Hermes => AppMeta {
                id: "hermes",
                command: "hermes",
                default_dir: ".hermes",
                config_file: Some("config.yaml"),
                format: ConfigFormat::Yaml,
                additive: true,
                default_visible: false,
            },
            AppType::Pi => AppMeta {
                id: "pi",
                command: "pi",
                default_dir: ".pi",
                config_file: None,
                format: ConfigFormat::Json,
                additive: true,
                default_visible: false,
            },
            AppType::Mcode => AppMeta {
                id: "mcode",
                command: "mcode",
                default_dir: ".minimax",
                config_file: None,
                format: ConfigFormat::Json,
                additive: true,
                default_visible: false,
            },
        }
    }

    /// 字符串标识。
    pub fn as_str(self) -> &'static str {
        self.meta().id
    }

    /// 是否累加式。
    pub fn is_additive(self) -> bool {
        self.meta().additive
    }

    /// 从字符串标识解析应用。
    pub fn from_str(s: &str) -> Option<AppType> {
        AppType::ALL.into_iter().find(|app| app.as_str() == s)
    }
}

impl std::fmt::Display for AppType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_round_trip() {
        let mut seen = std::collections::HashSet::new();
        for app in AppType::ALL {
            let id = app.as_str();
            assert!(seen.insert(id), "duplicate id {id}");
            assert_eq!(AppType::from_str(id), Some(app));
        }
    }

    #[test]
    fn serde_uses_lowercase_ids() {
        let json = serde_json::to_string(&AppType::GrokBuild).unwrap();
        assert_eq!(json, "\"grokbuild\"");
        let parsed: AppType = serde_json::from_str("\"opencode\"").unwrap();
        assert_eq!(parsed, AppType::OpenCode);
    }

    #[test]
    fn first_five_default_visible() {
        assert!(AppType::Claude.meta().default_visible);
        assert!(AppType::OpenCode.meta().default_visible);
        assert!(!AppType::Hermes.meta().default_visible);
    }
}
