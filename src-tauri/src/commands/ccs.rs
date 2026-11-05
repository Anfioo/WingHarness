//! CC Switch 的 Tauri 命令。
//!
//! 分三组：
//! - 应用管理：版本检测、可见性开关
//! - 应用配置（设置页）：设置读写、配置目录、目录选择对话框
//! - 供应商管理：供应商 CRUD 与切换（见文件后半部分）

use std::collections::HashMap;

use tauri_plugin_dialog::DialogExt;

use crate::ccs::app_type::AppType;
use crate::ccs::import::{self, ImportedProvider};
use crate::ccs::models::{self, FetchedModel};
use crate::ccs::seed;
use crate::ccs::settings::{self, CcsSettings};
use crate::ccs::version::{self, ToolVersion};

// ============================================================================
// 应用管理
// ============================================================================

/// 并发检测全部 AI CLI 的本地版本。
#[tauri::command]
pub async fn ccs_get_tool_versions() -> Result<Vec<ToolVersion>, String> {
    Ok(version::detect_all().await)
}

/// 获取当前可见的应用 ID 列表。
#[tauri::command]
pub async fn ccs_get_visible_apps() -> Result<Vec<String>, String> {
    let s = settings::load();
    Ok(s.visible_apps()
        .iter()
        .map(|a| a.as_str().to_string())
        .collect())
}

/// 设置某应用是否在主页面可见。保证至少一个应用保持可见。
#[tauri::command]
pub async fn ccs_set_app_visible(app: String, visible: bool) -> Result<bool, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    let mut s = settings::load();
    s.set_visible(app, visible);
    s.ensure_at_least_one_visible();
    settings::save(&s)?;
    Ok(true)
}

// ============================================================================
// 应用配置（设置页）
// ============================================================================

/// 获取完整 CC Switch 设置。
#[tauri::command]
pub async fn ccs_get_settings() -> Result<CcsSettings, String> {
    Ok(settings::load())
}

/// 保存完整 CC Switch 设置。
#[tauri::command]
pub async fn ccs_save_settings(new_settings: CcsSettings) -> Result<bool, String> {
    let mut s = new_settings;
    s.ensure_at_least_one_visible();
    settings::save(&s)?;
    Ok(true)
}

/// 获取某应用配置目录覆盖（空 = 默认）。
#[tauri::command]
pub async fn ccs_get_config_dir(app: String) -> Result<Option<String>, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    Ok(settings::load().config_dir_override(app))
}

/// 设置/重置某应用配置目录。
#[tauri::command]
pub async fn ccs_set_config_dir(app: String, dir: Option<String>) -> Result<bool, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    let mut s = settings::load();
    s.set_config_dir_override(app, dir);
    settings::save(&s)?;
    Ok(true)
}

/// 弹出系统目录选择对话框，返回所选目录绝对路径。
///
/// 起始位置是该应用当前的配置目录（不存在时退到用户主目录），而不是进程的
/// 默认位置 —— 后者会落在应用数据目录上，跟用户要改的东西无关。
#[tauri::command]
pub async fn ccs_browse_directory(
    handle: tauri::AppHandle,
    app: String,
) -> Result<Option<String>, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    let mut builder = handle.dialog().file();
    if let Some(dir) = crate::ccs::paths::browse_start_dir(app) {
        builder = builder.set_directory(dir);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

/// 获取各应用实际生效的配置目录（已应用覆盖）。
#[tauri::command]
pub async fn ccs_get_resolved_dirs() -> Result<HashMap<String, String>, String> {
    let mut map = HashMap::new();
    for app in AppType::ALL {
        map.insert(
            app.as_str().to_string(),
            crate::ccs::paths::config_dir(app)
                .to_string_lossy()
                .to_string(),
        );
    }
    Ok(map)
}

// ============================================================================
// 供应商管理
// ============================================================================

use crate::ccs::provider::Provider;
use crate::ccs::store;
use crate::ccs::switch;
use serde::Serialize;

/// 切换结果（回传给前端）。
#[derive(Debug, Serialize)]
pub struct CcsSwitchResult {
    pub app: String,
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "providerName")]
    pub provider_name: String,
    #[serde(rename = "configFile")]
    pub config_file: String,
}

/// 列出某应用的全部供应商。
#[tauri::command]
pub async fn ccs_get_providers(app: String) -> Result<Vec<Provider>, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    Ok(store::list(app))
}

/// 获取某应用当前生效的供应商 ID。
#[tauri::command]
pub async fn ccs_get_current_provider(app: String) -> Result<Option<String>, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    Ok(store::current(app))
}

/// 新增供应商，返回其 ID。若该应用尚无当前供应商，则设为当前并写入配置文件
/// （首次保存即生效）。
#[tauri::command]
pub async fn ccs_add_provider(app: String, provider: Provider) -> Result<String, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    let id = store::add(app, provider)?;
    if store::current(app).is_none() {
        switch::switch(app, &id)?;
    }
    Ok(id)
}

/// 更新供应商。
#[tauri::command]
pub async fn ccs_update_provider(
    app: String,
    original_id: String,
    provider: Provider,
) -> Result<bool, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    let new_id = provider.id.clone();
    store::update(app, &original_id, provider)?;

    // 若更新的是当前供应商，重新投影到配置文件（编辑即时生效）。
    if store::current(app).as_deref() == Some(original_id.as_str()) {
        switch::switch(app, &new_id)?;
    }
    Ok(true)
}

/// 删除供应商。
#[tauri::command]
pub async fn ccs_delete_provider(app: String, id: String) -> Result<bool, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    // 累加式应用：先清理配置文件中的节点。
    switch::remove_provider_node(app, &id)?;
    store::delete(app, &id)?;
    Ok(true)
}

/// 复制供应商，返回新 ID。
#[tauri::command]
pub async fn ccs_duplicate_provider(app: String, id: String) -> Result<String, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    store::duplicate(app, &id)
}

/// 切换当前供应商并写入配置文件。
#[tauri::command]
pub async fn ccs_switch_provider(app: String, id: String) -> Result<CcsSwitchResult, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    let provider = store::get(app, &id).ok_or_else(|| format!("Provider {id} not found"))?;
    switch::switch(app, &id)?;
    Ok(CcsSwitchResult {
        app: app.as_str().to_string(),
        provider_id: provider.id,
        provider_name: provider.name,
        config_file: crate::ccs::paths::config_file(app)
            .to_string_lossy()
            .to_string(),
    })
}

/// 调整供应商排序。
#[tauri::command]
pub async fn ccs_update_sort_order(app: String, ordered_ids: Vec<String>) -> Result<bool, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    store::reorder(app, ordered_ids)?;
    Ok(true)
}

// ============================================================================
// Claude Code 安装/集成开关
// ============================================================================

/// 查询 Claude onboarding 与插件集成的当前状态。
#[tauri::command]
pub async fn ccs_get_claude_switches() -> Result<HashMap<String, bool>, String> {
    let mut map = HashMap::new();
    map.insert(
        "skipClaudeOnboarding".to_string(),
        crate::ccs::onboarding::is_onboarding_skipped(),
    );
    map.insert(
        "enableClaudePluginIntegration".to_string(),
        crate::ccs::onboarding::is_plugin_integration_enabled(),
    );
    Ok(map)
}

/// 设置是否跳过 Claude Code 初次安装确认。
#[tauri::command]
pub async fn ccs_set_skip_onboarding(skip: bool) -> Result<bool, String> {
    if skip {
        crate::ccs::onboarding::skip_onboarding()?;
    } else {
        crate::ccs::onboarding::restore_onboarding()?;
    }
    Ok(true)
}

/// 设置是否启用 Claude 插件集成。
#[tauri::command]
pub async fn ccs_set_plugin_integration(enable: bool) -> Result<bool, String> {
    if enable {
        crate::ccs::onboarding::enable_plugin_integration()?;
    } else {
        crate::ccs::onboarding::disable_plugin_integration()?;
    }
    Ok(true)
}

// ============================================================================
// Codex 专属开关
// ============================================================================

/// Codex 会话压缩开关状态 + 会话目录占用（字节）。
#[derive(Debug, Serialize)]
pub struct CcsCodexSwitches {
    #[serde(rename = "sessionCompression")]
    pub session_compression: bool,
    #[serde(rename = "sessionsBytes")]
    pub sessions_bytes: u64,
}

/// 查询 Codex 专属开关状态。
#[tauri::command]
pub async fn ccs_get_codex_switches() -> Result<CcsCodexSwitches, String> {
    Ok(CcsCodexSwitches {
        session_compression: crate::ccs::codex_switches::is_session_compression_enabled(),
        sessions_bytes: crate::ccs::codex_switches::sessions_disk_usage(),
    })
}

/// 设置 Codex 历史会话压缩；返回写入后的状态。
#[tauri::command]
pub async fn ccs_set_codex_session_compression(enabled: bool) -> Result<bool, String> {
    crate::ccs::codex_switches::set_session_compression(enabled)
}

// ============================================================================
// 编辑器底
// ============================================================================

/// 计算供应商编辑器的视图与基准。Claude 返回自身对象；Codex 返回 `{config, auth}`。
#[tauri::command]
pub async fn ccs_editor_base(
    app: String,
    provider: Option<Provider>,
) -> Result<serde_json::Value, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    let provider = provider.or_else(|| store::current(app).and_then(|id| store::get(app, &id)));
    let view = crate::ccs::editor::view(app, provider.as_ref())?;
    Ok(serde_json::json!({ "view": view.view, "baseline": view.baseline }))
}

/// 由编辑器内容算出应存进供应商的最小配置（去掉与底相同的部分）。
#[tauri::command]
pub async fn ccs_editor_delta(
    app: String,
    edited: serde_json::Value,
    base: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    Ok(crate::ccs::editor::delta(app, edited, base))
}

// ============================================================================
// 模型列表
// ============================================================================

/// 获取某供应商配置的可用模型列表（走 OpenAI 兼容的 GET /v1/models）。
#[tauri::command]
pub async fn ccs_fetch_models(
    app: String,
    provider: Provider,
) -> Result<Vec<FetchedModel>, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    // reqwest::blocking 不能跑在 tokio worker 线程上，丢到独立 blocking 线程池。
    tauri::async_runtime::spawn_blocking(move || {
        let (base_url, api_key, models_url, api_format) = match app {
            AppType::Claude => models::claude_fetch_params(&provider.settings_config),
            AppType::Codex => models::codex_fetch_params(&provider.settings_config),
            _ => return Err("该应用暂不支持获取模型列表".to_string()),
        };
        models::fetch_models(
            &base_url,
            &api_key,
            models_url.as_deref(),
            api_format.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Model fetch task failed: {e}"))?
}

// ============================================================================
// 导入本机配置
// ============================================================================

/// 把本机已有的 CLI 配置导入为一条供应商（id = `default`）并设为当前。
#[tauri::command]
pub async fn ccs_import_live_config(app: String) -> Result<bool, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    seed::import_and_activate(app)
}

// ============================================================================
// 供应商导入（预览 → 勾选 → 保存）
// ============================================================================

/// 预览可导入的供应商。`source` 为 `live` / `ccswitch` / `json`；`dbPath` 仅
/// `ccswitch` 且用户自选文件时使用。
#[tauri::command]
pub async fn ccs_import_preview(
    app: String,
    source: String,
    db_path: Option<String>,
) -> Result<Vec<ImportedProvider>, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    match source.as_str() {
        "live" => import::preview_live(app),
        "ccswitch" => import::preview_cc_switch_db(app, db_path),
        "json" => {
            let path = db_path.ok_or_else(|| "缺少文件路径".to_string())?;
            import::preview_json_file(app, &path)
        }
        other => Err(format!("Unknown import source {other}")),
    }
}

/// 保存勾选的导入条目（按 id 覆盖已有，否则新增），返回处理条数。
#[tauri::command]
pub async fn ccs_import_save(
    app: String,
    providers: Vec<ImportedProvider>,
) -> Result<usize, String> {
    let app = AppType::from_str(&app).ok_or_else(|| format!("Unknown app {app}"))?;
    import::save_imported(app, providers)
}

/// 弹出文件选择对话框，返回所选文件路径（`.db` / `.json`）。
#[tauri::command]
pub async fn ccs_pick_import_file(
    app: tauri::AppHandle,
    kind: String,
) -> Result<Option<String>, String> {
    let (extensions, label) = match kind.as_str() {
        "json" => (vec!["json"], "JSON"),
        _ => (vec!["db"], "cc-switch 数据库"),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(label, &extensions)
        .pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });
    rx.await.map_err(|e| e.to_string())
}
