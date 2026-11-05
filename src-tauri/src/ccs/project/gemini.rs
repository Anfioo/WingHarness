//! Gemini CLI 投影器（同时写 `settings.json` 和 `.env`）。
//!
//! 供应商行的 settings_config 结构：
//! ```json
//! {
//!   "env": { "GOOGLE_GEMINI_BASE_URL": "...", "GEMINI_API_KEY": "...", "GEMINI_MODEL": "..." },
//!   "model": { "name": "..." },
//!   "authType": "gemini-api-key"
//! }
//! ```

use serde_json::Value;

use crate::ccs::patch::PatchOp;
use crate::ccs::project::FileTarget;
use crate::ccs::provider::Provider;

/// `.env` 中固定的关键字段。
const FLOOR_ENV_KEYS: &[&str] = &[
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "GEMINI_API_KEY_AUTH_MECHANISM",
    "GEMINI_CLI_CUSTOM_HEADERS",
    "GEMINI_DEFAULT_AUTH_TYPE",
    "GEMINI_CLI_USE_COMPUTE_ADC",
    "CODE_ASSIST_ENDPOINT",
    "CODE_ASSIST_API_VERSION",
];

/// `.env` 键是否为关键字段。
fn is_floor_env(key: &str) -> bool {
    key.starts_with("GOOGLE_") || FLOOR_ENV_KEYS.contains(&key)
}

/// settings.json 键路径是否为关键字段。
fn is_floor_settings(path: &[String]) -> bool {
    matches!(path, [p1, p2] if
        (p1 == "model" && p2 == "name")
        || (p1 == "security"))
        || matches!(path, [p1, p2, p3] if
            p1 == "security" && p2 == "auth" && p3 == "selectedType")
}

/// 判断某目标文件中键路径是否为关键字段。
pub fn is_floor_path(target_key: &str, path: &[String]) -> bool {
    match target_key {
        "env" => path.len() == 1 && is_floor_env(&path[0]),
        "settings" => is_floor_settings(path),
        _ => false,
    }
}

/// 投影为两个目标文件的操作。
pub fn project(provider: &Provider) -> Result<Vec<FileTarget>, String> {
    let config = &provider.settings_config;
    let mut env_ops = Vec::new();
    let mut settings_ops = Vec::new();

    // env 块 → .env
    if let Some(env) = config.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            env_ops.push(PatchOp::set(&[key], value.clone()));
        }
    }

    // model.name → settings.json
    if let Some(name) = config.pointer("/model/name") {
        settings_ops.push(PatchOp::set(&["model", "name"], name.clone()));
    }
    // authType → settings.json security.auth.selectedType
    if let Some(auth_type) = config.get("authType") {
        settings_ops.push(PatchOp::set(
            &["security", "auth", "selectedType"],
            auth_type.clone(),
        ));
    }

    Ok(vec![
        FileTarget::new("env", env_ops),
        FileTarget::new("settings", settings_ops),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floor_detection() {
        assert!(is_floor_path("env", &["GEMINI_API_KEY".into()]));
        assert!(is_floor_path("env", &["GOOGLE_GEMINI_BASE_URL".into()]));
        assert!(!is_floor_path("env", &["GEMINI_SANDBOX".into()]));
        assert!(is_floor_path("settings", &["model".into(), "name".into()]));
        assert!(is_floor_path(
            "settings",
            &["security".into(), "auth".into(), "selectedType".into()]
        ));
        assert!(!is_floor_path("settings", &["theme".into(), "dark".into()]));
    }

    #[test]
    fn projects_both_targets() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({
                "env": {
                    "GOOGLE_GEMINI_BASE_URL": "https://x",
                    "GEMINI_API_KEY": "k",
                    "GEMINI_MODEL": "gemini-2"
                },
                "model": { "name": "gemini-2" },
                "authType": "gemini-api-key"
            }),
        );
        let targets = project(&provider).unwrap();
        assert_eq!(targets.len(), 2);
        let env = &targets[0];
        assert_eq!(env.key, "env");
        assert_eq!(env.ops.len(), 3);
        let settings = &targets[1];
        assert_eq!(settings.key, "settings");
        assert_eq!(settings.ops.len(), 2);
    }
}
