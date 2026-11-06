//! 供应商切换引擎。
//!
//! 把选中的供应商投影到应用的真实配置文件上：
//! - 切换式应用（Claude/Codex/Gemini/Grok）：先枚举并清除现有配置中的关键字段，
//!   再写入目标供应商，保证同一份配置不会残留上一家的凭据/模型；
//! - 累加式应用（OpenCode/OpenClaw/Hermes/Pi/Mcode）：只按精确路径写入/更新该
//!   供应商节点，不触碰其他供应商。
//!
//! 写盘后更新 providers.json 中的 current 指针。

use std::fs;

use super::app_type::{AppType, ConfigFormat};
use super::patch;
use super::paths;
use super::project::{self, FileTarget};
use super::store;
use super::{ccswitch, settings};

/// 切换某应用到指定供应商。
pub async fn switch(app: AppType, provider_id: &str) -> Result<(), String> {
    let provider = store::get(app, provider_id)
        .await
        .ok_or_else(|| format!("Provider {provider_id} not found"))?;

    let targets = project::project(app, &provider)?;
    for target in targets {
        write_target(app, &target)?;
    }

    store::set_current(app, Some(provider_id)).await?;

    // 同步官方 cc-switch 的「当前」标记。失败不往外抛：配置文件与本应用的当前
    // 指针都已写好，这只是附加动作。
    if settings::load().sync_cc_switch_db {
        if let Err(e) = ccswitch::sync_current(app, provider_id).await {
            eprintln!("Failed to sync the cc-switch database: {e}");
        }
    }
    Ok(())
}

/// 把一个目标文件的投影写入磁盘。
fn write_target(app: AppType, target: &FileTarget) -> Result<(), String> {
    let file = paths::target_file(app, &target.key);

    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    // 整写目标（如 Codex 的 auth.json）：直接落原始内容。
    if let Some(raw) = &target.raw {
        return atomic_write(&file, raw);
    }

    let format = target_format(app, &target.key);
    let existing = fs::read_to_string(&file).unwrap_or_default();

    let mut ops = Vec::new();

    // 切换式：先清除现有 floor 字段。
    if !app.meta().additive {
        let key = target.key.clone();
        let floor_fn = move |path: &[String]| project::is_floor_path(app, &key, path);
        ops.extend(patch::floor_removals_for(format, &existing, &floor_fn));
    }

    ops.extend(target.ops.iter().cloned());

    let new_content = patch::apply_for(format, &existing, &ops)?;
    atomic_write(&file, &new_content)?;
    Ok(())
}

/// 删除某供应商在累加式应用配置中的节点（删除供应商时调用）。
///
/// 对切换式应用无意义（其配置随当前供应商整体投影），返回 Ok。
pub async fn remove_provider_node(app: AppType, provider_id: &str) -> Result<(), String> {
    if !app.meta().additive {
        return Ok(());
    }
    // 累加式应用的节点路径由投影器决定：重新投影一份空操作不现实，
    // 这里按各应用已知的节点路径删除。
    let paths_to_clear = additive_node_paths(app, provider_id);
    for (target_key, node_path) in paths_to_clear {
        let format = target_format(app, &target_key);
        let file = paths::target_file(app, &target_key);
        let existing = fs::read_to_string(&file).unwrap_or_default();
        let ops = vec![patch::PatchOp::remove(
            &node_path.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        )];
        let new_content = patch::apply_for(format, &existing, &ops)?;
        atomic_write(&file, &new_content)?;
    }
    Ok(())
}

/// 累加式应用中某供应商的节点路径（target_key, path）。
fn additive_node_paths(app: AppType, provider_id: &str) -> Vec<(String, Vec<String>)> {
    match app {
        AppType::OpenCode => vec![("main".into(), vec!["provider".into(), provider_id.into()])],
        AppType::OpenClaw => vec![(
            "main".into(),
            vec!["models".into(), "providers".into(), provider_id.into()],
        )],
        // Hermes/Pi/Mcode 采用整片段编辑，节点路径不固定，删除时不做配置清理
        // （数据已从 providers.json 移除，用户可在配置文件中手动清理）。
        _ => vec![],
    }
}

/// 解析某目标文件的格式。
fn target_format(app: AppType, target_key: &str) -> ConfigFormat {
    match (app, target_key) {
        (AppType::Gemini, "env") => ConfigFormat::Env,
        (AppType::Gemini, "settings") => ConfigFormat::Json,
        // Codex 的 auth.json 是 JSON（放在 config.toml 同目录）。
        (AppType::Codex, "auth") => ConfigFormat::Json,
        _ => app.meta().format,
    }
}

/// 原子写：先写临时文件，再 rename 覆盖目标。
fn atomic_write(file: &std::path::Path, content: &str) -> Result<(), String> {
    let tmp = file.with_extension("ccs.tmp");
    fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, file).map_err(|e| format!("Failed to replace {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_format_resolves_gemini() {
        assert_eq!(target_format(AppType::Gemini, "env"), ConfigFormat::Env);
        assert_eq!(
            target_format(AppType::Gemini, "settings"),
            ConfigFormat::Json
        );
        assert_eq!(target_format(AppType::Claude, "main"), ConfigFormat::Json);
        assert_eq!(target_format(AppType::Codex, "main"), ConfigFormat::Toml);
    }

    #[test]
    fn additive_node_paths_known() {
        let paths = additive_node_paths(AppType::OpenCode, "x");
        assert_eq!(paths[0].1, vec!["provider".to_string(), "x".to_string()]);
        let paths = additive_node_paths(AppType::OpenClaw, "x");
        assert_eq!(
            paths[0].1,
            vec![
                "models".to_string(),
                "providers".to_string(),
                "x".to_string()
            ]
        );
    }

    #[test]
    fn switching_clears_previous_provider_floor() {
        use serde_json::json;

        // 现有配置：供应商 A 的连接信息 + 用户的非 floor 字段。
        let existing = serde_json::to_string_pretty(&json!({
            "hooks": { "keep": 1 },
            "env": {
                "ANTHROPIC_BASE_URL": "https://a",
                "ANTHROPIC_AUTH_TOKEN": "tok-a"
            }
        }))
        .unwrap();

        // 切到供应商 B。
        let b = crate::ccs::provider::Provider::new(
            "b".into(),
            "B".into(),
            json!({
                "env": {
                    "ANTHROPIC_BASE_URL": "https://b",
                    "ANTHROPIC_AUTH_TOKEN": "tok-b"
                }
            }),
        );
        let targets = project::project(AppType::Claude, &b).unwrap();
        let target = &targets[0];

        let floor_fn = |p: &[String]| project::is_floor_path(AppType::Claude, &target.key, p);
        let mut ops = patch::floor_removals_for(ConfigFormat::Json, &existing, &floor_fn);
        ops.extend(target.ops.clone());

        let result = patch::apply_for(ConfigFormat::Json, &existing, &ops).unwrap();
        let v: serde_json::Value = serde_json::from_str(&result).unwrap();

        // B 生效。
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://b");
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "tok-b");
        // 用户字段保留。
        assert_eq!(v["hooks"]["keep"], 1);
        // A 的凭据不残留。
        assert!(!result.contains("tok-a"));
        assert!(!result.contains("https://a"));
    }

    #[test]
    fn codex_switch_preserves_user_sections() {
        use serde_json::json;

        // 现有 config.toml：供应商连接信息 + 用户的 projects/windows 等非 floor 内容。
        let existing = r#"model_provider = "old"
model = "old-model"

[model_providers.old]
base_url = "https://old"
wire_api = "responses"

[projects."m:\\mabangprojectsworkflows"]
trust_level = "trusted"

[windows]
sandbox = "unelevated"
"#;

        let provider = crate::ccs::provider::Provider::new(
            "b".into(),
            "B".into(),
            json!({
                "config": "model_provider = \"custom\"\nmodel = \"gpt-5\"\n[model_providers.custom]\nbase_url = \"https://new\"\nwire_api = \"responses\"\n",
                "auth": { "OPENAI_API_KEY": "sk-new" }
            }),
        );
        let targets = project::project(AppType::Codex, &provider).unwrap();
        let target = &targets[0];

        let floor_fn = |p: &[String]| project::is_floor_path(AppType::Codex, &target.key, p);
        let mut ops = patch::floor_removals_for(ConfigFormat::Toml, existing, &floor_fn);
        ops.extend(target.ops.clone());
        let result = patch::apply_for(ConfigFormat::Toml, existing, &ops).unwrap();

        // 用户的 projects / windows 保留。
        assert!(
            result.contains("m:\\\\mabangprojectsworkflows")
                || result.contains("mabangprojectsworkflows")
        );
        assert!(result.contains("trust_level"));
        assert!(result.contains("[windows]"));
        assert!(result.contains("unelevated"));
        // 新供应商生效。
        assert!(result.contains("https://new"));
        assert!(result.contains("sk-new"));
    }
}
