//! 供应商可用模型列表获取。
//!
//! 走 OpenAI 兼容的 `GET /v1/models`（也兼容 Anthropic 的 `{data:[{id}]}` 与
//! 智谱的 `{models:[{slug}]}` 形状）。对齐 cc-switch 的候选端点策略：baseURL
//! 命中已知「Anthropic 兼容子路径」后缀时，追加「剥离后缀再拼 /v1/models、
//! /models」的兜底候选。

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 获取到的模型信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

const FETCH_TIMEOUT_SECS: u64 = 15;
const ERROR_BODY_MAX_CHARS: usize = 512;

/// 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

/// 模型列表响应（`data` 为 OpenAI/Anthropic 形状，`models` 为智谱形状）。
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
    models: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    owned_by: Option<String>,
}

/// 获取供应商的可用模型列表（按候选端点顺序尝试）。
pub fn fetch_models(
    base_url: &str,
    api_key: &str,
    models_url: Option<&str>,
    api_format: Option<&str>,
) -> Result<Vec<FetchedModel>, String> {
    let candidates = build_models_url_candidates(base_url, models_url)?;
    let headers = build_headers(api_key, api_format)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut last_err: Option<String> = None;
    for url in &candidates {
        let resp = match client.get(url).headers(headers.clone()).send() {
            Ok(r) => r,
            Err(e) => return Err(format!("Request failed: {e}")),
        };
        let status = resp.status();

        if status.is_success() {
            let parsed: ModelsResponse = resp
                .json()
                .map_err(|e| format!("Failed to parse response: {e}"))?;
            let mut models: Vec<FetchedModel> = if let Some(data) = parsed.data {
                data.into_iter()
                    .map(|m| FetchedModel {
                        id: m.id,
                        owned_by: m.owned_by,
                    })
                    .collect()
            } else {
                catalog_model_ids(parsed.models)
                    .into_iter()
                    .map(|id| FetchedModel { id, owned_by: None })
                    .collect()
            };
            models.sort_by(|a, b| a.id.cmp(&b.id));
            return Ok(models);
        }

        let body = truncate_body(resp.text().unwrap_or_default());
        if status == reqwest::StatusCode::NOT_FOUND
            || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
        {
            last_err = Some(format!("HTTP {status}: {body}"));
            continue;
        }
        return Err(format!("HTTP {status}: {body}"));
    }

    Err(format!(
        "All candidates failed: {}",
        last_err.unwrap_or_else(|| "no candidates".to_string())
    ))
}

fn build_headers(
    api_key: &str,
    api_format: Option<&str>,
) -> Result<reqwest::header::HeaderMap, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
    if api_key.is_empty() {
        return Err("API Key is required to fetch models".to_string());
    }
    let mut headers = HeaderMap::new();
    let (name, value) = match api_format {
        Some("anthropic-messages") => (
            HeaderName::from_static("x-api-key"),
            HeaderValue::from_str(api_key).map_err(|e| e.to_string())?,
        ),
        Some("google-generative-ai") => (
            HeaderName::from_static("x-goog-api-key"),
            HeaderValue::from_str(api_key).map_err(|e| e.to_string())?,
        ),
        _ => (
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| e.to_string())?,
        ),
    };
    headers.insert(name, value);
    Ok(headers)
}

/// `models[]` 条目对应的模型 id：`slug` 优先，回退 `id`；非法项跳过。
fn catalog_model_ids(models: Option<serde_json::Value>) -> Vec<String> {
    let Some(serde_json::Value::Array(entries)) = models else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|m| {
            ["slug", "id"]
                .iter()
                .find_map(|k| m.get(k)?.as_str().filter(|s| !s.is_empty()))
        })
        .map(str::to_string)
        .collect()
}

fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

/// 构造模型列表端点的候选 URL（去重、保序）。
pub fn build_models_url_candidates(
    base_url: &str,
    models_url_override: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(raw) = models_url_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(vec![trimmed.to_string()]);
        }
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() || !trimmed.contains("://") {
        return Err("Base URL is empty or invalid".to_string());
    }

    let mut candidates: Vec<String> = Vec::new();

    // baseURL 已以版本段 /v{N} 结尾时（如 /v1、智谱 .../paas/v4），模型端点是
    // {base}/models；版本段非 /v1 时再补 /v1/models 兜底。
    if ends_with_version_segment(trimmed) {
        candidates.push(format!("{trimmed}/models"));
        if !trimmed.ends_with("/v1") {
            candidates.push(format!("{trimmed}/v1/models"));
        }
    } else {
        candidates.push(format!("{trimmed}/v1/models"));
    }

    // 命中兼容子路径后缀时，剥离后再拼 /v1/models、/models。
    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            candidates.push(format!("{root}/v1/models"));
            candidates.push(format!("{root}/models"));
        }
    }

    let mut unique: Vec<String> = Vec::with_capacity(candidates.len());
    for url in candidates {
        if !unique.iter().any(|u| u == &url) {
            unique.push(url);
        }
    }
    Ok(unique)
}

fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(*suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// 从供应商 settings_config 中读取取模型所需的信息（供命令层调用）。
///
/// 返回 `(base_url, api_key, models_url, api_format)`。
pub fn claude_fetch_params(
    config: &serde_json::Value,
) -> (String, String, Option<String>, Option<String>) {
    let env = config.get("env");
    let get = |k: &str| {
        env.and_then(|e| e.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let base_url = get("ANTHROPIC_BASE_URL");
    let mut api_key = get("ANTHROPIC_AUTH_TOKEN");
    if api_key.is_empty() {
        api_key = get("ANTHROPIC_API_KEY");
    }
    let models_url = config
        .get("modelsUrl")
        .and_then(|v| v.as_str())
        .map(String::from);
    let api_format = config
        .get("apiFormat")
        .and_then(|v| v.as_str())
        .map(String::from);
    (base_url, api_key, models_url, api_format)
}

/// 从 Codex settings_config 中读取取模型所需的信息。
pub fn codex_fetch_params(
    config: &serde_json::Value,
) -> (String, String, Option<String>, Option<String>) {
    // 新式：{config: "<config.toml 文本>", auth: {OPENAI_API_KEY}}。
    if let Some(text) = config.get("config").and_then(|v| v.as_str()) {
        let parsed: serde_json::Value = toml::from_str::<toml::Value>(text)
            .ok()
            .and_then(|t| serde_json::to_value(t).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let base_url = parsed
            .pointer("/model_providers/custom/base_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let api_key = config
            .pointer("/auth/OPENAI_API_KEY")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return (base_url, api_key, None, None);
    }
    // 旧式：settings_config 直接是 config.toml 结构。
    let custom = config
        .pointer("/model_providers/custom")
        .unwrap_or(&serde_json::Value::Null);
    let base_url = custom
        .get("base_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut api_key = custom
        .get("experimental_bearer_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if api_key.is_empty() {
        api_key = custom
            .get("env_key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
    }
    (base_url, api_key, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_plain_root() {
        let c = build_models_url_candidates("https://api.example.com", None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn candidates_with_v1() {
        let c = build_models_url_candidates("https://api.example.com/v1", None).unwrap();
        assert_eq!(c, vec!["https://api.example.com/v1/models"]);
    }

    #[test]
    fn candidates_zhipu_paas_v4() {
        let c = build_models_url_candidates("https://open.bigmodel.cn/api/coding/paas/v4", None)
            .unwrap();
        assert_eq!(
            c,
            vec![
                "https://open.bigmodel.cn/api/coding/paas/v4/models",
                "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
            ]
        );
    }

    #[test]
    fn candidates_strip_anthropic_suffix() {
        let c = build_models_url_candidates("https://api.deepseek.com/anthropic", None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
    }

    #[test]
    fn candidates_longest_suffix_wins() {
        let c = build_models_url_candidates("https://api.z.ai/api/anthropic", None).unwrap();
        assert_eq!(
            c,
            vec![
                "https://api.z.ai/api/anthropic/v1/models",
                "https://api.z.ai/v1/models",
                "https://api.z.ai/models",
            ]
        );
    }

    #[test]
    fn candidates_override_single() {
        let c = build_models_url_candidates(
            "https://api.deepseek.com/anthropic",
            Some("https://api.deepseek.com/models"),
        )
        .unwrap();
        assert_eq!(c, vec!["https://api.deepseek.com/models"]);
    }

    #[test]
    fn candidates_empty_errors() {
        assert!(build_models_url_candidates("", None).is_err());
    }

    #[test]
    fn catalog_ids_slug_then_id() {
        let v = serde_json::json!([
            {"slug": "glm-4.7"},
            {"id": "openai-shaped"},
            {"name": "neither"},
            {}
        ]);
        assert_eq!(catalog_model_ids(Some(v)), vec!["glm-4.7", "openai-shaped"]);
    }

    #[test]
    fn headers_pick_scheme_by_format() {
        use reqwest::header::AUTHORIZATION;
        let bearer = build_headers("k", None).unwrap();
        assert_eq!(bearer[AUTHORIZATION], "Bearer k");
        let anthropic = build_headers("k", Some("anthropic-messages")).unwrap();
        assert_eq!(anthropic["x-api-key"], "k");
        let google = build_headers("k", Some("google-generative-ai")).unwrap();
        assert_eq!(google["x-goog-api-key"], "k");
        assert!(build_headers("", None).is_err());
    }

    #[test]
    fn claude_params_read_env() {
        let v = serde_json::json!({
            "env": { "ANTHROPIC_BASE_URL": "https://x", "ANTHROPIC_AUTH_TOKEN": "tok" }
        });
        let (base, key, models, fmt) = claude_fetch_params(&v);
        assert_eq!(base, "https://x");
        assert_eq!(key, "tok");
        assert!(models.is_none() && fmt.is_none());
    }

    #[test]
    fn sort_is_stable_by_id() {
        let mut models = vec![
            FetchedModel {
                id: "b".into(),
                owned_by: None,
            },
            FetchedModel {
                id: "a".into(),
                owned_by: None,
            },
        ];
        models.sort_by(|x, y| x.id.cmp(&y.id));
        assert_eq!(models[0].id, "a");
    }
}
