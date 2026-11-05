//! 路径解析：各 AI CLI 的配置目录/文件，以及 CC Switch 自身的数据位置。
//!
//! 所有「应用配置目录」的解析都必须经过这里，保证自定义目录覆盖对版本检测、
//! 切换写入全局生效。

use std::path::PathBuf;

use super::app_type::AppType;
use super::settings;

/// 用户主目录（复用 MCP Hub 的实现，避免引入 dirs crate）。
pub fn home_dir() -> PathBuf {
    crate::mcphub::paths::home_dir()
}

/// 应用配置目录：优先用户自定义覆盖，否则为「主目录 / 默认相对目录」。
pub fn config_dir(app: AppType) -> PathBuf {
    if let Some(override_dir) = settings::load().config_dir_override(app) {
        return PathBuf::from(override_dir);
    }
    home_dir().join(app.meta().default_dir)
}

/// 应用主配置文件的完整路径。
///
/// 对 OpenCode 会探测现存的 `.jsonc` / `.json`；对没有明确配置文件的应用
/// （Pi / Mcode）返回配置目录本身，由投影器自行决定文件名。
pub fn config_file(app: AppType) -> PathBuf {
    let dir = config_dir(app);
    match app {
        AppType::OpenCode => resolve_opencode_file(&dir),
        AppType::Pi | AppType::Mcode => dir,
        _ => match app.meta().config_file {
            Some(name) => dir.join(name),
            None => dir,
        },
    }
}

/// OpenCode 配置文件：优先已存在的 `opencode.jsonc`，其次 `opencode.json`，
/// 都不存在时默认 `opencode.json`。
pub fn resolve_opencode_file(dir: &std::path::Path) -> PathBuf {
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    dir.join("opencode.json")
}

/// Gemini CLI 的环境文件（`<dir>/.env`）。
pub fn gemini_env_file(app: AppType) -> PathBuf {
    config_dir(app).join(".env")
}

/// 解析某个「逻辑目标文件」的实际路径。
///
/// - `main`：应用主配置文件（绝大多数应用只有这一个目标）
/// - Gemini 额外有 `settings`（settings.json）和 `env`（.env）
pub fn target_file(app: AppType, target_key: &str) -> PathBuf {
    match (app, target_key) {
        (AppType::Gemini, "settings") => config_dir(app).join("settings.json"),
        (AppType::Gemini, "env") => gemini_env_file(app),
        // Codex 的登录凭据文件与 config.toml 同目录。
        (AppType::Codex, "auth") => config_dir(app).join("auth.json"),
        _ => config_file(app),
    }
}

/// Claude Code 的全局文件 `~/.claude.json`（onboarding 状态等）。
///
/// 该文件固定在主目录下，不随 Claude 配置目录覆盖而改变。
pub fn claude_global_file() -> PathBuf {
    home_dir().join(".claude.json")
}

/// CC Switch 自身的数据目录（`<app data dir>/ccs`）。
pub fn store_dir() -> PathBuf {
    crate::config::dir().join("ccs")
}

/// 供应商数据库文件（`<app data dir>/ccs/ccs.db`，SQLite）。
pub fn store_db() -> PathBuf {
    store_dir().join("ccs.db")
}

/// 旧的供应商 JSON 文件（`<app data dir>/ccs/providers.json`）。
///
/// 仅用于一次性迁移到 SQLite；迁移后会被改名为 `providers.json.migrated`。
pub fn legacy_store_file() -> PathBuf {
    store_dir().join("providers.json")
}

/// 官方预设播种标记文件（每个安装只播一次）。
pub fn seed_marker_file() -> PathBuf {
    store_dir().join("official-seeded")
}

/// 目录选择对话框的起始位置。
///
/// 优先该应用当前的配置目录（要改目录的人多半就站在那儿），目录不存在时退到
/// 用户主目录 —— 这个一定存在，好过让对话框停在一个不存在的位置上。
pub fn browse_start_dir(app: AppType) -> Option<PathBuf> {
    let dir = config_dir(app);
    if dir.is_dir() {
        return Some(dir);
    }
    let home = home_dir();
    home.is_dir().then_some(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_prefers_existing_jsonc() {
        let tmp = std::env::temp_dir().join(format!("oc-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("opencode.jsonc"), "{}").unwrap();
        assert!(resolve_opencode_file(&tmp).ends_with("opencode.jsonc"));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn opencode_defaults_to_json() {
        let tmp = std::env::temp_dir().join(format!("oc2-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(resolve_opencode_file(&tmp).ends_with("opencode.json"));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn config_file_uses_meta_name() {
        assert!(config_file(AppType::Claude).ends_with("settings.json"));
        assert!(config_file(AppType::Codex).ends_with("config.toml"));
    }

    /// 对话框起始位置要么是该应用的配置目录，要么退到主目录 —— 不能停在一个
    /// 不存在的位置（Windows 的目录选择器会忽略不存在的路径）。
    #[test]
    fn browse_start_dir_is_an_existing_directory() {
        for app in AppType::ALL {
            if let Some(dir) = browse_start_dir(app) {
                assert!(dir.is_dir(), "{}: {} 不是目录", app.as_str(), dir.display());
            }
        }
    }
}
