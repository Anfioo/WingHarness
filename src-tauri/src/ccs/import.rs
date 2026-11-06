//! 供应商导入：预览 → 勾选 → 保存。
//!
//! 三个来源：
//! - 本机 CLI 配置（`~/.claude/settings.json`、`~/.codex/config.toml` + `auth.json`）
//! - 官方 cc-switch 的 SQLite 数据库（`~/.cc-switch/cc-switch.db` 或用户自选 `.db`）
//! - 用户选择的 JSON 文件（本应用导出格式）
//!
//! 预览返回带 `status`（new / update）的条目供前端勾选；保存按 id 覆盖或新增。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::app_type::AppType;
use super::paths;
use super::provider::{Provider, ProviderMeta};
use super::store;

/// 预览/导入条目（含相对当前应用的状态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProvider {
    pub id: String,
    pub name: String,
    #[serde(rename = "settingsConfig")]
    pub settings_config: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<ProviderMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<String>,
    /// `new`（该应用尚无此 id）或 `update`（已存在，导入即覆盖）。
    pub status: String,
}

impl ImportedProvider {
    async fn from_provider(app: AppType, p: Provider) -> Self {
        let status = if store::get(app, &p.id).await.is_some() {
            "update"
        } else {
            "new"
        };
        ImportedProvider {
            id: p.id,
            name: p.name,
            settings_config: p.settings_config,
            website_url: p.website_url,
            category: p.category,
            created_at: p.created_at,
            notes: p.notes,
            meta: p.meta,
            icon: p.icon,
            icon_color: p.icon_color,
            status: status.to_string(),
        }
    }

    fn into_provider(self) -> Provider {
        Provider {
            id: self.id,
            name: self.name,
            settings_config: self.settings_config,
            website_url: self.website_url,
            category: self.category,
            created_at: self.created_at,
            sort_index: None,
            notes: self.notes,
            meta: self.meta,
            icon: self.icon,
            icon_color: self.icon_color,
        }
    }
}

// ============================================================================
// 来源一：本机 CLI 配置
// ============================================================================

/// 预览本机 CLI 配置（Claude / Codex）。文件不存在时返回空列表。
pub async fn preview_live(app: AppType) -> Result<Vec<ImportedProvider>, String> {
    let Some(provider) = read_live(app)? else {
        return Ok(Vec::new());
    };
    Ok(vec![ImportedProvider::from_provider(app, provider).await])
}

/// 读取本机 live 配置为一条供应商。
fn read_live(app: AppType) -> Result<Option<Provider>, String> {
    match app {
        AppType::Claude => {
            let file = paths::config_file(app);
            if !file.exists() {
                return Ok(None);
            }
            let text = std::fs::read_to_string(&file)
                .map_err(|e| format!("Failed to read {}: {e}", file.display()))?;
            let settings: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
            Ok(Some(simple_provider(
                "default",
                "默认（本机配置）",
                settings,
            )))
        }
        AppType::Codex => {
            let config_file = paths::config_file(app);
            if !config_file.exists() {
                return Ok(None);
            }
            let config_text = std::fs::read_to_string(&config_file)
                .map_err(|e| format!("Failed to read {}: {e}", config_file.display()))?;
            let auth_file = paths::config_dir(app).join("auth.json");
            let auth: Value = std::fs::read_to_string(&auth_file)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_else(|| json!({}));
            // 对齐 cc-switch：config.toml 文本 + auth.json 对象分开保存。
            let settings = json!({ "config": config_text, "auth": auth });
            Ok(Some(simple_provider(
                "default",
                "默认（本机配置）",
                settings,
            )))
        }
        _ => Ok(None),
    }
}

// ============================================================================
// 来源二：官方 cc-switch 数据库
// ============================================================================

/// cc-switch 数据库默认路径（`~/.cc-switch/cc-switch.db`）。
pub fn default_cc_switch_db() -> std::path::PathBuf {
    paths::home_dir().join(".cc-switch").join("cc-switch.db")
}

/// 预览 cc-switch 数据库中的供应商。`db_path` 为空时用默认路径。
pub async fn preview_cc_switch_db(
    app: AppType,
    db_path: Option<String>,
) -> Result<Vec<ImportedProvider>, String> {
    let path = db_path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(default_cc_switch_db);
    if !path.exists() {
        return Err(format!("cc-switch 数据库不存在：{}", path.display()));
    }
    read_cc_switch_db(app, &path).await
}

async fn read_cc_switch_db(app: AppType, path: &Path) -> Result<Vec<ImportedProvider>, String> {
    // 直读官方库：表结构与官方 providers 表一致，可复用同一套 DAO 读取。
    let db = super::db::Database::open_readonly(path).await?;
    let providers = db
        .list_providers(app.as_str())
        .await
        .map_err(|e| format!("读取 providers 表失败：{e}"))?;

    let mut out = Vec::new();
    for provider in providers {
        out.push(ImportedProvider::from_provider(app, provider).await);
    }
    Ok(out)
}

// ============================================================================
// 来源三：JSON 文件（本应用导出格式）
// ============================================================================

/// 预览 JSON 文件中的供应商。接受：`{data:{app:{list:[...]}}}` / `[...]` / `{...}`。
pub async fn preview_json_file(app: AppType, path: &str) -> Result<Vec<ImportedProvider>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("无法读取文件 {path}：{e}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败：{e}"))?;

    let raw: Vec<Value> = match value {
        Value::Array(items) => items,
        Value::Object(ref map) => {
            // 本应用导出格式：{ data: { <app>: { list: [...] } } }
            if let Some(list) = map
                .get("data")
                .and_then(|d| d.get(app.as_str()))
                .and_then(|a| a.get("list"))
                .and_then(Value::as_array)
            {
                list.clone()
            } else {
                vec![value.clone()]
            }
        }
        _ => return Err("文件不是有效的供应商 JSON。".to_string()),
    };

    let mut out = Vec::new();
    for item in raw {
        let Some(provider) = parse_provider_value(app, item).await else {
            continue;
        };
        out.push(provider);
    }
    Ok(out)
}

async fn parse_provider_value(app: AppType, value: Value) -> Option<ImportedProvider> {
    let obj = value.as_object()?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("imported")
        .to_string();
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let settings_config = obj
        .get("settingsConfig")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let meta = obj
        .get("meta")
        .and_then(|m| serde_json::from_value::<ProviderMeta>(m.clone()).ok());
    Some(ImportedProvider {
        status: if store::get(app, &id).await.is_some() {
            "update".to_string()
        } else {
            "new".to_string()
        },
        id,
        name,
        settings_config,
        website_url: obj
            .get("websiteUrl")
            .and_then(Value::as_str)
            .map(String::from),
        category: obj
            .get("category")
            .and_then(Value::as_str)
            .map(String::from),
        created_at: obj.get("createdAt").and_then(Value::as_i64),
        notes: obj.get("notes").and_then(Value::as_str).map(String::from),
        meta,
        icon: obj.get("icon").and_then(Value::as_str).map(String::from),
        icon_color: obj
            .get("iconColor")
            .and_then(Value::as_str)
            .map(String::from),
    })
}

// ============================================================================
// 保存
// ============================================================================

/// 保存勾选的导入条目：按 id 覆盖已有，否则新增。返回处理条数。
pub async fn save_imported(
    app: AppType,
    providers: Vec<ImportedProvider>,
) -> Result<usize, String> {
    let mut count = 0;
    for imp in providers {
        let provider = imp.into_provider();
        let id = provider.id.clone();
        if store::get(app, &id).await.is_some() {
            store::update(app, &id, provider).await?;
        } else {
            store::add(app, provider).await?;
        }
        count += 1;
    }
    Ok(count)
}

// ============================================================================
// 辅助
// ============================================================================

fn simple_provider(id: &str, name: &str, settings_config: Value) -> Provider {
    Provider {
        id: id.to_string(),
        name: name.to_string(),
        settings_config,
        website_url: None,
        category: Some("custom".to_string()),
        created_at: Some(now_ms()),
        sort_index: None,
        notes: None,
        meta: None,
        icon: None,
        icon_color: None,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parses_json_array_of_providers() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("ccs-import-{}.json", std::process::id()));
        std::fs::write(
            &path,
            r#"[{"id":"x","name":"X","settingsConfig":{"env":{"ANTHROPIC_BASE_URL":"https://x"}}}]"#,
        )
        .unwrap();
        let out = preview_json_file(AppType::Claude, path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "x");
        assert_eq!(out[0].status, "new");
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn parses_store_file_shape() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("ccs-store-{}.json", std::process::id()));
        std::fs::write(
            &path,
            r#"{"version":1,"data":{"claude":{"current":null,"list":[{"id":"a","name":"A","settingsConfig":{}}]}}}"#,
        )
        .unwrap();
        let out = preview_json_file(AppType::Claude, path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "a");
        std::fs::remove_file(&path).unwrap();
    }
}
