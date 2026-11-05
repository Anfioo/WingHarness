//! OpenClaw（`~/.openclaw/openclaw.json`）投影器。
//!
//! 累加式：每个供应商写入 `models.providers.<id>` 节点。settings_config：
//! ```json
//! {
//!   "providerId": "x",
//!   "baseURL": "https://x",
//!   "apiKey": "k",
//!   "api": "openai-completions",
//!   "models": [{ "id": "m1", "name": "Model 1" }]
//! }
//! ```

use serde_json::{json, Value};

use crate::ccs::patch::PatchOp;
use crate::ccs::provider::Provider;

/// 累加式，无全局 floor。
pub fn is_floor_path(_path: &[String]) -> bool {
    false
}

/// 组装 `models.providers.<id>` 节点。
pub fn project(provider: &Provider) -> Result<Vec<PatchOp>, String> {
    let c = &provider.settings_config;
    let provider_id = c
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or(&provider.id);

    let mut node = serde_json::Map::new();
    if let Some(v) = c.get("baseURL") {
        node.insert("baseURL".to_string(), v.clone());
    }
    if let Some(v) = c.get("apiKey") {
        node.insert("apiKey".to_string(), v.clone());
    }
    if let Some(v) = c.get("api") {
        node.insert("api".to_string(), v.clone());
    }
    if let Some(v) = c.get("models") {
        node.insert("models".to_string(), v.clone());
    } else if let Some(model) = c.get("model").and_then(Value::as_str) {
        node.insert(
            "models".to_string(),
            json!([{ "id": model, "name": model }]),
        );
    }

    Ok(vec![PatchOp::set(
        &["models", "providers", provider_id],
        Value::Object(node),
    )])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_provider_node() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            serde_json::json!({
                "providerId": "x",
                "baseURL": "https://x",
                "apiKey": "k",
                "models": [{ "id": "m1", "name": "M1" }]
            }),
        );
        let ops = project(&provider).unwrap();
        assert_eq!(
            ops[0].path(),
            &[
                "models".to_string(),
                "providers".to_string(),
                "x".to_string()
            ]
        );
        if let PatchOp::Set { value, .. } = &ops[0] {
            assert_eq!(value["baseURL"], "https://x");
            assert_eq!(value["models"][0]["id"], "m1");
        }
    }
}
