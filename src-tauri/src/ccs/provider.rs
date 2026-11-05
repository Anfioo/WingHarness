//! 供应商数据结构。
//!
//! 供应商的核心是 `settings_config`：一个结构随应用不同的 JSON 值，保存该供应商的
//! 完整连接配置（地址、凭据、模型、兼容开关等）。切换时由对应应用的投影器把它
//! 翻译成目标配置文件中的关键字段。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 供应商。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    /// 同一应用内唯一的 ID。
    pub id: String,
    /// 显示名称。
    pub name: String,
    /// 供应商完整配置（结构随应用不同）。
    #[serde(rename = "settingsConfig")]
    pub settings_config: Value,
    /// 官网地址。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "websiteUrl")]
    pub website_url: Option<String>,
    /// 分类（official / custom 等）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 创建时间（Unix 毫秒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "createdAt")]
    pub created_at: Option<i64>,
    /// 排序索引。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "sortIndex")]
    pub sort_index: Option<usize>,
    /// 备注。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// 供应商元数据。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<ProviderMeta>,
    /// 图标名称。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// 图标颜色（Hex）。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "iconColor")]
    pub icon_color: Option<String>,
}

/// 供应商元数据（不直接写入目标 CLI 配置，仅用于控制切换行为）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderMeta {
    /// 供应商类型标识。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "providerType")]
    pub provider_type: Option<String>,
    /// Claude Code 使用的鉴权字段名（默认 ANTHROPIC_AUTH_TOKEN，可选 ANTHROPIC_API_KEY）。
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "apiKeyField")]
    pub api_key_field: Option<String>,
}

impl Provider {
    /// 构造一个仅含必填字段的供应商。
    pub fn new(id: String, name: String, settings_config: Value) -> Self {
        Self {
            id,
            name,
            settings_config,
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
        }
    }

    /// Claude Code 是否使用 ANTHROPIC_API_KEY 字段（而非默认的 ANTHROPIC_AUTH_TOKEN）。
    pub fn claude_uses_api_key_field(&self) -> bool {
        self.meta
            .as_ref()
            .and_then(|m| m.api_key_field.as_deref())
            .map(|field| field.eq_ignore_ascii_case("ANTHROPIC_API_KEY"))
            .unwrap_or(false)
    }

    /// 读取 Claude Code 配置中的 Base URL。
    pub fn claude_base_url(&self) -> Option<&str> {
        self.settings_config
            .pointer("/env/ANTHROPIC_BASE_URL")
            .and_then(|v| v.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_with_camel_case() {
        let provider = Provider::new(
            "p1".into(),
            "Test".into(),
            json!({ "env": { "ANTHROPIC_BASE_URL": "https://x" } }),
        );
        let s = serde_json::to_string(&provider).unwrap();
        assert!(s.contains("\"settingsConfig\""));
        let back: Provider = serde_json::from_str(&s).unwrap();
        assert_eq!(back.id, "p1");
        assert_eq!(back.claude_base_url(), Some("https://x"));
    }

    #[test]
    fn detects_api_key_field_choice() {
        let mut provider = Provider::new("p1".into(), "T".into(), json!({}));
        assert!(!provider.claude_uses_api_key_field());
        provider.meta = Some(ProviderMeta {
            api_key_field: Some("ANTHROPIC_API_KEY".into()),
            ..Default::default()
        });
        assert!(provider.claude_uses_api_key_field());
    }
}
