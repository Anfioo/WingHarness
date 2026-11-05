//! Hermes（`~/.hermes/config.yaml`）投影器。
//!
//! settings_config 直接存 config.yaml 对应片段，例如：
//! ```json
//! { "model": { "provider": "openrouter", "base_url": "https://x", "default": "m1" } }
//! ```
//! 递归展开为精确路径 set，保留配置文件中的其他内容。

use crate::ccs::patch::PatchOp;
use crate::ccs::project::flatten_config;
use crate::ccs::provider::Provider;

/// 累加式，无全局 floor（按精确路径写入）。
pub fn is_floor_path(_path: &[String]) -> bool {
    false
}

pub fn project(provider: &Provider) -> Result<Vec<PatchOp>, String> {
    Ok(flatten_config(&provider.settings_config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flattens_model_section() {
        let provider = Provider::new(
            "p1".into(),
            "T".into(),
            json!({ "model": { "provider": "openrouter", "base_url": "https://x" } }),
        );
        let ops = project(&provider).unwrap();
        let paths: Vec<String> = ops.iter().map(|o| o.path().join(".")).collect();
        assert!(paths.contains(&"model.provider".to_string()));
        assert!(paths.contains(&"model.base_url".to_string()));
    }
}
