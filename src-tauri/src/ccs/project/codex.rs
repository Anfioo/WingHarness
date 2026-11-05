//! Codex 投影器（`~/.codex/config.toml` + `~/.codex/auth.json`）。
//!
//! 对齐 cc-switch：Codex 供应商行是 `{ "config": "<config.toml 文本>", "auth": {...} }`。
//! 投影时——
//! - `config` 解析成 config.toml 的关键字段（选路、地址、模型、wire_api）；
//! - `auth.OPENAI_API_KEY` **注入路由表的 `experimental_bearer_token`**（Codex 0.149 起
//!   自定义 provider 不再读 auth.json 里的 Key，auth.json 只留给官方登录）；
//! - auth.json 本身在保存/导入时作为独立文件保留（官方登录态等），切换时整体写入，
//!   但第三方 Key 不进 auth.json。
//!
//! 兼容旧式：settings_config 直接是 config.toml 的 JSON 结构。

use serde_json::{json, Value};

use crate::ccs::patch::PatchOp;
use crate::ccs::project::FileTarget;
use crate::ccs::provider::Provider;

/// CC Switch 写入的路由表 id。
const ROUTE_ID: &str = "custom";
/// 路由表所在的 section。
const PROVIDER_SECTION: &str = "model_providers.custom";

/// 顶层关键字段。
const FLOOR_TOP: &[&str] = &[
    "model_provider",
    "openai_base_url",
    "model",
    "review_model",
    "model_reasoning_effort",
    "plan_mode_reasoning_effort",
    "disable_response_storage",
    "model_catalog_json",
    "experimental_bearer_token",
    "base_url",
    "wire_api",
];

/// 判断键路径是否为关键字段。
pub fn is_floor_path(path: &[String]) -> bool {
    match path {
        [key] => FLOOR_TOP.contains(&key.as_str()),
        [section, id, ..] if section == "model_providers" && id == ROUTE_ID => true,
        _ => false,
    }
}

/// 从 config.toml 文本读出当前选中的 `model_provider` id（非空）。
///
/// live 里选中的路由表（可能是别的 id，如 cc-switch 写的 `CodexPlusPlus`）也归关键字段，
/// 切走时一并清掉，避免遗留旧供应商的 `[model_providers.<id>]` 表。
pub fn selected_provider_id(existing: &str) -> Option<String> {
    let doc: toml_edit::DocumentMut = existing.parse().ok()?;
    let id = doc.get("model_provider")?.as_str()?.trim();
    if id.is_empty() || id == ROUTE_ID {
        None
    } else {
        Some(id.to_string())
    }
}

/// 把供应商投影成目标文件操作（config.toml + 可选 auth.json）。
pub fn project(provider: &Provider) -> Result<Vec<FileTarget>, String> {
    let config = &provider.settings_config;

    // 新式：config 是 TOML 文本字符串；auth 是独立对象。
    if let Some(text) = config.get("config").and_then(Value::as_str) {
        let mut targets = Vec::new();
        let mut toml_json = if text.trim().is_empty() {
            json!({})
        } else {
            toml::from_str::<toml::Value>(text)
                .ok()
                .and_then(|t| serde_json::to_value(t).ok())
                .unwrap_or_else(|| json!({}))
        };

        // 行的 API Key 注入路由表的 experimental_bearer_token。
        if let Some(key) = config
            .get("auth")
            .and_then(|a| a.get("OPENAI_API_KEY"))
            .and_then(Value::as_str)
            .filter(|k| !k.trim().is_empty())
        {
            inject_bearer_token(&mut toml_json, key);
        }

        let mut ops = Vec::new();
        flatten(&[], &toml_json, &mut ops);
        // 只写关键字段（floor）：projects / windows / mcp_servers 等用户内容一律不投影，
        // 切换时从 live 原样保留。
        ops.retain(|op| is_floor_path(op.path()));
        targets.push(FileTarget::main_target(ops));

        // auth.json 只承载官方登录：第三方行的 auth 只是 OPENAI_API_KEY（已注入 config），
        // 不写进 auth.json，避免覆盖用户的 ChatGPT 登录。空 auth 同样不写。
        if let Some(auth) = config.get("auth").and_then(Value::as_object) {
            if !auth.is_empty() && !auth.contains_key("OPENAI_API_KEY") {
                let content = serde_json::to_string_pretty(&Value::Object(auth.clone()))
                    .map_err(|e| format!("auth 序列化失败：{e}"))?;
                targets.push(FileTarget::raw("auth", content));
            }
        }
        return Ok(targets);
    }

    // 旧式：settings_config 直接就是 config.toml 结构。
    let mut ops = Vec::new();
    flatten(&[], config, &mut ops);
    ops.retain(|op| is_floor_path(op.path()));
    Ok(vec![FileTarget::main_target(ops)])
}

/// 把 API Key 写进 `[model_providers.custom].experimental_bearer_token`，
/// 并保证选路指向 custom（Codex 只从路由表读 Key）。
fn inject_bearer_token(toml_json: &mut Value, key: &str) {
    let Some(root) = toml_json.as_object_mut() else {
        return;
    };
    if root.get("model_provider").is_none() {
        root.insert("model_provider".to_string(), json!(ROUTE_ID));
    }
    let section = root.entry("model_providers").or_insert_with(|| json!({}));
    let Some(providers) = section.as_object_mut() else {
        return;
    };
    let route = providers.entry(ROUTE_ID).or_insert_with(|| json!({}));
    if let Some(route) = route.as_object_mut() {
        route.insert("experimental_bearer_token".to_string(), json!(key.trim()));
    }
}

/// 递归把 JSON 对象展开成「叶子路径 → set」操作。
fn flatten(prefix: &[String], value: &Value, ops: &mut Vec<PatchOp>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let mut path = prefix.to_vec();
                path.push(k.clone());
                flatten(&path, v, ops);
            }
        }
        other => {
            let path_ref: Vec<&str> = prefix.iter().map(|s| s.as_str()).collect();
            ops.push(PatchOp::set(&path_ref, other.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floor_detection() {
        assert!(is_floor_path(&["model".into()]));
        assert!(is_floor_path(&["model_provider".into()]));
        assert!(is_floor_path(&[
            "model_providers".into(),
            "custom".into(),
            "base_url".into()
        ]));
        assert!(!is_floor_path(&[
            "model_providers".into(),
            "other".into(),
            "x".into()
        ]));
    }

    #[test]
    fn new_format_injects_key_into_config_and_writes_auth() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({
                "config": "model_provider = \"custom\"\nmodel = \"gpt-5\"\n[model_providers.custom]\nbase_url = \"https://x\"\nwire_api = \"responses\"\n",
                "auth": { "OPENAI_API_KEY": "sk-x" }
            }),
        );
        let targets = project(&provider).unwrap();
        assert_eq!(targets.len(), 1);
        let main = &targets[0];
        assert_eq!(main.key, "main");
        let paths: Vec<String> = main.ops.iter().map(|o| o.path().join(".")).collect();
        assert!(paths.contains(&"model_provider".to_string()));
        assert!(paths.contains(&"model_providers.custom.base_url".to_string()));
        // Key 注入 config.toml 的路由表（Codex 只从这里读）。
        assert!(paths.contains(&"model_providers.custom.experimental_bearer_token".to_string()));
        // auth 只含 OPENAI_API_KEY：不写 auth.json（避免覆盖官方登录）。
        assert_eq!(targets.len(), 1);
    }

    #[test]
    fn injects_key_when_config_lacks_custom_table() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({ "config": "model = \"gpt-5\"\n", "auth": { "OPENAI_API_KEY": "sk-y" } }),
        );
        let targets = project(&provider).unwrap();
        let paths: Vec<String> = targets[0].ops.iter().map(|o| o.path().join(".")).collect();
        assert!(paths.contains(&"model_provider".to_string()));
        assert!(paths.contains(&"model_providers.custom.experimental_bearer_token".to_string()));
    }

    #[test]
    fn auth_without_key_still_writes_auth_file() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({
                "config": "model = \"gpt-5\"\n",
                "auth": { "tokens": { "access_token": "x" } }
            }),
        );
        let targets = project(&provider).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[1].key, "auth");
    }

    #[test]
    fn empty_auth_is_not_written() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({ "config": "model = \"gpt-5\"\n", "auth": {} }),
        );
        let targets = project(&provider).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].key, "main");
    }

    #[test]
    fn legacy_format_projects_directly() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({
                "model_provider": "custom",
                "model": "gpt-5",
                "model_providers": { "custom": { "base_url": "https://x" } }
            }),
        );
        let targets = project(&provider).unwrap();
        assert_eq!(targets.len(), 1);
        assert!(targets[0].raw.is_none());
    }
}
