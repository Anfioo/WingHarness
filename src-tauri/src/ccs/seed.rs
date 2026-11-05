//! 启动播种与「导入本机配置」。
//!
//! 对齐官方 cc-switch 的首次运行行为：全新安装时把用户**已有的** CLI 配置文件
//! 读成一条 `default` 供应商并设为当前（这样用户原本就在用的中转站/官方登录不会
//! 凭空消失），再补一条官方预设条目作为「切回官方」的入口。
//!
//! 本轮只支持 Claude Code（读 `~/.claude/settings.json`）；其余应用返回空，命令行
//! 为后续扩展预留。

use serde_json::json;

use super::app_type::AppType;
use super::paths;
use super::provider::Provider;
use super::store;

/// 官方预设供应商的稳定 ID（与投影器无关，仅用于去重与识别）。
pub fn official_id(app: AppType) -> Option<&'static str> {
    match app {
        AppType::Claude => Some("claude-official"),
        _ => None,
    }
}

/// 构造某应用的官方预设供应商（空配置 = 官方端点）。
pub fn official_provider(app: AppType) -> Option<Provider> {
    match app {
        AppType::Claude => Some(Provider {
            id: official_id(app).unwrap().to_string(),
            name: "Claude Official".to_string(),
            settings_config: json!({ "env": {} }),
            website_url: Some("https://www.anthropic.com/claude-code".to_string()),
            category: Some("official".to_string()),
            created_at: Some(now_ms()),
            sort_index: None,
            notes: None,
            meta: None,
            icon: Some("anthropic".to_string()),
            icon_color: Some("#D4915D".to_string()),
        }),
        _ => None,
    }
}

/// 读取本机 live 配置为一条供应商（id = `default`）。
///
/// 文件不存在或解析失败时返回 `Ok(None)`（不报错，保证应用始终可用）。
pub fn import_live_config(app: AppType) -> Result<Option<Provider>, String> {
    match app {
        AppType::Claude => {
            let file = paths::config_file(app);
            if !file.exists() {
                return Ok(None);
            }
            let text = std::fs::read_to_string(&file)
                .map_err(|e| format!("Failed to read {}: {e}", file.display()))?;
            let settings: serde_json::Value =
                serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
            Ok(Some(Provider {
                id: "default".to_string(),
                name: "default".to_string(),
                settings_config: settings,
                website_url: None,
                category: Some("custom".to_string()),
                created_at: Some(now_ms()),
                sort_index: None,
                notes: None,
                meta: None,
                icon: None,
                icon_color: None,
            }))
        }
        // 其余应用（Codex 为 TOML 等）留待后续。
        _ => Ok(None),
    }
}

/// 启动时调用一次：为每个应用导入本机配置并补官方条目。
///
/// - 仅当该应用 store 为空时导入 live 为 `default` 并设为当前；
/// - 官方条目按全局标记文件只播一次，用户删除后不复活。
pub fn init() {
    for app in AppType::ALL {
        import_live_if_empty(app);

        if !seeded_already() {
            seed_official(app);
        }
    }
    mark_seeded();
}

/// 手动把本机配置导入为供应商（空状态「导入当前配置」按钮）。
///
/// 已存在 id 为 `default` 的供应商时返回 `Ok(false)`，不覆盖。
pub fn import_and_activate(app: AppType) -> Result<bool, String> {
    if store::get(app, "default").is_some() {
        return Ok(false);
    }
    let Some(provider) = import_live_config(app)? else {
        return Ok(false);
    };
    let id = store::add(app, provider)?;
    store::set_current(app, Some(&id))?;
    super::switch::switch(app, &id)?;
    Ok(true)
}

/// 若该应用尚无任何供应商，导入 live 并设为当前。
fn import_live_if_empty(app: AppType) {
    if !store::list(app).is_empty() {
        return;
    }
    if let Ok(Some(provider)) = import_live_config(app) {
        if let Ok(id) = store::add(app, provider) {
            let _ = store::set_current(app, Some(&id));
        }
    }
}

/// 追加官方条目（已存在同 id 时跳过）。
fn seed_official(app: AppType) {
    let Some(provider) = official_provider(app) else {
        return;
    };
    let id = provider.id.clone();
    if store::get(app, &id).is_some() {
        return;
    }
    let _ = store::add(app, provider);
}

/// 官方条目是否已播种过（标记文件存在即视为已播）。
fn seeded_already() -> bool {
    paths::seed_marker_file().exists()
}

/// 落标记文件；失败静默（下次启动会重试，代价可接受）。
fn mark_seeded() {
    let file = paths::seed_marker_file();
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&file, b"");
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

    #[test]
    fn official_provider_only_for_claude() {
        let p = official_provider(AppType::Claude).unwrap();
        assert_eq!(p.id, "claude-official");
        assert_eq!(p.category.as_deref(), Some("official"));
        assert_eq!(p.settings_config, json!({ "env": {} }));
        assert!(official_provider(AppType::Codex).is_none());
    }

    #[test]
    fn import_unsupported_app_is_none() {
        assert!(import_live_config(AppType::Codex).unwrap().is_none());
    }
}
