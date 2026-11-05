//! OpenCode（`~/.config/opencode/opencode.json`）投影器。
//!
//! 累加式：每个供应商写入 `provider.<id>` 节点，多个供应商共存，切换引擎不做
//! 全局 floor 清除。供应商行的 settings_config：
//! ```json
//! {
//!   "providerId": "my-prov",
//!   "npm": "@ai-sdk/openai-compatible",
//!   "name": "My Provider",
//!   "baseURL": "https://x",
//!   "apiKey": "sk-x",
//!   "models": { "model-id": { "name": "Model" } }
//! }
//! ```

use serde_json::{json, Value};

use crate::ccs::patch::PatchOp;
use crate::ccs::provider::Provider;

/// 累加式应用没有全局关键字段，floor 判定恒为 false（按 provider id 精确操作）。
pub fn is_floor_path(_path: &[String]) -> bool {
    false
}

/// 投影为 `provider.<id>` 节点的 set 操作。
pub fn project(provider: &Provider) -> Result<Vec<PatchOp>, String> {
    let c = &provider.settings_config;

    let provider_id = c
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or(&provider.id);

    let npm = c
        .get("npm")
        .cloned()
        .unwrap_or_else(|| json!("@ai-sdk/openai-compatible"));

    let mut node = serde_json::Map::new();
    node.insert("npm".to_string(), npm);

    // name
    if let Some(name) = c.get("name") {
        node.insert("name".to_string(), name.clone());
    }

    // options.baseURL / options.apiKey
    let mut options = serde_json::Map::new();
    if let Some(base_url) = c.get("baseURL") {
        options.insert("baseURL".to_string(), base_url.clone());
    }
    if let Some(api_key) = c.get("apiKey") {
        options.insert("apiKey".to_string(), api_key.clone());
    }
    if !options.is_empty() {
        node.insert("options".to_string(), Value::Object(options));
    }

    // models：直接用提供的 models，否则用单模型构造。
    if let Some(models) = c.get("models") {
        node.insert("models".to_string(), models.clone());
    } else if let Some(model) = c.get("model").and_then(Value::as_str) {
        let mut models = serde_json::Map::new();
        models.insert(
            model.to_string(),
            json!({ "name": c.get("modelName").cloned().unwrap_or(json!(model)) }),
        );
        node.insert("models".to_string(), Value::Object(models));
    }

    Ok(vec![PatchOp::set(
        &["provider", provider_id],
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
            json!({
                "providerId": "my-prov",
                "npm": "@ai-sdk/openai-compatible",
                "name": "My",
                "baseURL": "https://x",
                "apiKey": "sk-x",
                "models": { "gpt-1": { "name": "GPT 1" } }
            }),
        );
        let ops = project(&provider).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(
            ops[0].path(),
            &["provider".to_string(), "my-prov".to_string()]
        );
        if let PatchOp::Set { value, .. } = &ops[0] {
            assert_eq!(value["options"]["baseURL"], "https://x");
            assert_eq!(value["options"]["apiKey"], "sk-x");
            assert!(value.get("models").is_some());
        } else {
            panic!("expected set op");
        }
    }

    #[test]
    fn builds_models_from_single_model() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({ "providerId": "x", "baseURL": "https://x", "apiKey": "k", "model": "m-1" }),
        );
        let ops = project(&provider).unwrap();
        if let PatchOp::Set { value, .. } = &ops[0] {
            assert!(value["models"].get("m-1").is_some());
        }
    }
}
