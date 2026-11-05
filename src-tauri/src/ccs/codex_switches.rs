//! Codex 专属开关：`~/.codex/config.toml` 的 `[features]` 标志位。
//!
//! 对齐官方 cc-switch 的 `services/codex_session_compression.rs`：目前只包含
//! 「压缩历史会话」（`local_thread_store_compression`）——开启时写
//! `[features] local_thread_store_compression = true`，关闭时删掉该键，回到
//! Codex 默认。开关状态以 config.toml 为准，不另存设置。

use std::path::Path;

use toml_edit::DocumentMut;

use super::app_type::{AppType, ConfigFormat};
use super::patch::{self, PatchOp};
use super::paths;

/// 会话压缩功能对应的 `[features]` 键。
const FEATURE_KEY: &str = "local_thread_store_compression";

/// 读取 config.toml 中 `[features] <key>` 是否开启。
///
/// 兼容 `key = true` 与 `key = { enabled = true }` 两种写法（对齐官方）。
fn feature_enabled(text: &str, key: &str) -> bool {
    let Ok(doc) = text.parse::<DocumentMut>() else {
        return false;
    };
    let Some(item) = doc.get("features").and_then(|features| features.get(key)) else {
        return false;
    };
    item.as_bool()
        .or_else(|| item.get("enabled").and_then(toml_edit::Item::as_bool))
        .unwrap_or(false)
}

/// config.toml 文本（读取失败按空处理）。
fn read_config_text() -> String {
    std::fs::read_to_string(paths::config_file(AppType::Codex)).unwrap_or_default()
}

/// 会话压缩是否已开启。
pub fn is_session_compression_enabled() -> bool {
    feature_enabled(&read_config_text(), FEATURE_KEY)
}

/// 设置会话压缩开关；返回写入后的状态。已是目标状态时不写文件。
pub fn set_session_compression(enabled: bool) -> Result<bool, String> {
    if is_session_compression_enabled() == enabled {
        return Ok(enabled);
    }
    let file = paths::config_file(AppType::Codex);
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let ops = vec![if enabled {
        PatchOp::set(&["features", FEATURE_KEY], serde_json::json!(true))
    } else {
        PatchOp::remove(&["features", FEATURE_KEY])
    }];
    let new_content = patch::apply_for(ConfigFormat::Toml, &existing, &ops)?;
    atomic_write(&file, &new_content)?;
    Ok(is_session_compression_enabled())
}

/// Codex 会话目录（`sessions/` + `archived_sessions/`）当前占用的字节数。
pub fn sessions_disk_usage() -> u64 {
    let dir = paths::config_dir(AppType::Codex);
    [dir.join("sessions"), dir.join("archived_sessions")]
        .iter()
        .map(|root| path_size(root))
        .sum()
}

/// 递归统计目录占用（文件大小之和）。
fn path_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| path_size(&entry.path()))
        .sum()
}

/// 原子写：先写临时文件，再 rename 覆盖目标。
fn atomic_write(file: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let tmp = file.with_extension("ccs.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, file).map_err(|e| format!("Failed to replace {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bool_and_enabled_table_forms() {
        assert!(feature_enabled(
            "[features]\nlocal_thread_store_compression = true\n",
            FEATURE_KEY
        ));
        assert!(feature_enabled(
            "[features.local_thread_store_compression]\nenabled = true\n",
            FEATURE_KEY
        ));
        assert!(!feature_enabled(
            "[features]\nlocal_thread_store_compression = false\n",
            FEATURE_KEY
        ));
        assert!(!feature_enabled(
            "[features]\nweb_search = true\n",
            FEATURE_KEY
        ));
        assert!(!feature_enabled("", FEATURE_KEY));
    }

    #[test]
    fn enabling_adds_key_and_preserves_other_content() {
        let before = "# my config\nmodel = \"gpt-5\"\n\n[features]\nweb_search = true # keep\n";
        let ops = vec![PatchOp::set(
            &["features", FEATURE_KEY],
            serde_json::json!(true),
        )];
        let after = patch::apply_for(ConfigFormat::Toml, before, &ops).unwrap();
        assert!(after.starts_with("# my config\nmodel = \"gpt-5\"\n"));
        assert!(after.contains("web_search = true # keep"));
        assert!(feature_enabled(&after, FEATURE_KEY));
    }

    #[test]
    fn disabling_removes_key() {
        let before = "[features]\nlocal_thread_store_compression = true\nweb_search = true\n";
        let ops = vec![PatchOp::remove(&["features", FEATURE_KEY])];
        let after = patch::apply_for(ConfigFormat::Toml, before, &ops).unwrap();
        assert!(!after.contains(FEATURE_KEY));
        assert!(after.contains("web_search = true"));
    }
}
