//! Claude Code（`~/.claude/settings.json`）投影器。

use serde_json::Value;

use crate::ccs::patch::PatchOp;
use crate::ccs::provider::Provider;

/// 协议选择器（属于关键字段）。
const PROTOCOL_SELECTORS: &[&str] = &[
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
];

/// `env` 中整个前缀都属于连接/鉴权的前缀。
const FLOOR_ENV_PREFIXES: &[&str] = &["ANTHROPIC_", "AWS_", "VERTEX_REGION_"];

/// 顶层关键字段。
const FLOOR_TOP: &[&str] = &[
    "apiKeyHelper",
    "apiBaseUrl",
    "primaryModel",
    "smallFastModel",
    "apiKey",
    "model",
    "fallbackModel",
    "modelOverrides",
    "modelPicker",
    "advisorModel",
    "awsAuthRefresh",
    "awsCredentialExport",
    "gcpAuthRefresh",
];

/// `env` 键是否为关键字段。
fn is_floor_env(key: &str) -> bool {
    FLOOR_ENV_PREFIXES.iter().any(|p| key.starts_with(p))
        || PROTOCOL_SELECTORS.contains(&key)
        || (key.starts_with("CLAUDE_CODE_SKIP_") && key.ends_with("_AUTH"))
}

/// 顶层键是否为关键字段。
fn is_floor_top_key(key: &str) -> bool {
    FLOOR_TOP.contains(&key)
}

/// 判断键路径是否为关键字段。
pub fn is_floor_path(path: &[String]) -> bool {
    match path {
        [key] => is_floor_top_key(key),
        [section, key] if section == "env" => is_floor_env(key),
        _ => false,
    }
}

/// 把供应商投影成设置操作。
pub fn project(provider: &Provider) -> Result<Vec<PatchOp>, String> {
    let config = &provider.settings_config;
    let mut ops = Vec::new();

    // env 块：投影其中所有键（表单只放连接/模型相关键）。
    if let Some(env) = config.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            ops.push(PatchOp::set(&["env", key], value.clone()));
        }
    }

    // 顶层关键字段。
    if let Some(root) = config.as_object() {
        for (key, value) in root {
            if key == "env" {
                continue;
            }
            if is_floor_top_key(key) {
                ops.push(PatchOp::set(&[key], value.clone()));
            }
        }
    }

    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floor_detection() {
        assert!(is_floor_path(&["env".into(), "ANTHROPIC_BASE_URL".into()]));
        assert!(is_floor_path(&[
            "env".into(),
            "ANTHROPIC_AUTH_TOKEN".into()
        ]));
        assert!(is_floor_path(&["env".into(), "AWS_REGION".into()]));
        assert!(is_floor_path(&[
            "env".into(),
            "CLAUDE_CODE_USE_BEDROCK".into()
        ]));
        assert!(!is_floor_path(&["env".into(), "DISABLE_TELEMETRY".into()]));
        assert!(is_floor_path(&["model".into()]));
        assert!(!is_floor_path(&["hooks".into()]));
        assert!(!is_floor_path(&["env".into()]));
    }

    #[test]
    fn projects_env_and_top_fields() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://x",
                    "ANTHROPIC_AUTH_TOKEN": "tok"
                },
                "model": "claude-sonnet"
            }),
        );
        let ops = project(&provider).unwrap();
        let paths: Vec<String> = ops.iter().map(|o| o.path().join(".")).collect();
        assert!(paths.contains(&"env.ANTHROPIC_BASE_URL".to_string()));
        assert!(paths.contains(&"env.ANTHROPIC_AUTH_TOKEN".to_string()));
        assert!(paths.contains(&"model".to_string()));
    }
}
