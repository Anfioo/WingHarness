//! Grok Build（`~/.grok/config.toml`）投影器。
//!
//! settings_config 直接存成 config.toml 结构：
//! ```toml
//! [models]
//! default = "my-model"
//! [model."my-model"]
//! model = "..."
//! base_url = "..."
//! api_key = "..."
//! ```

use crate::ccs::project::flatten_config;
use crate::ccs::provider::Provider;

/// 判断键路径是否为关键字段。
///
/// `models.default` 与 `model.<表名>` 下的内容归供应商所有。
pub fn is_floor_path(path: &[String]) -> bool {
    match path {
        [p1, p2] if p1 == "models" && p2 == "default" => true,
        [p1, ..] if p1 == "model" => true,
        _ => false,
    }
}

/// 递归展开为 config.toml 设置操作。
pub fn project(provider: &Provider) -> Result<Vec<crate::ccs::patch::PatchOp>, String> {
    Ok(flatten_config(&provider.settings_config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floor_detection() {
        assert!(is_floor_path(&["models".into(), "default".into()]));
        assert!(is_floor_path(&[
            "model".into(),
            "my-model".into(),
            "base_url".into()
        ]));
        assert!(!is_floor_path(&["other".into()]));
    }

    #[test]
    fn flattens_config() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({
                "models": { "default": "m1" },
                "model": { "m1": { "base_url": "https://x", "api_key": "k" } }
            }),
        );
        let ops = project(&provider).unwrap();
        let paths: Vec<String> = ops.iter().map(|o| o.path().join(".")).collect();
        assert!(paths.contains(&"models.default".to_string()));
        assert!(paths.contains(&"model.m1.base_url".to_string()));
    }
}
