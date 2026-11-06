//! CC Switch 的应用级设置（存储在 config.json 的 `ccs` 字段中）。
//!
//! 只包含需要本软件自己记住的东西：各应用可见性、各应用配置目录覆盖。两者都用
//! map 存储，未显式设置时回退到应用的默认值，这样新增应用无需修改结构。
//!
//! 注意：Claude / Codex 的「应用专属开关」不在这里 —— 它们直接读写 CLI 自己的
//! 配置文件，以那边的内容为准（见 [`super::onboarding`]、[`super::codex_switches`]），
//! 本软件不另存一份状态，免得两边不一致。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::app_type::AppType;

/// CC Switch 设置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CcsSettings {
    /// 各应用是否在主页面可见（key 为应用 ID）。未列出的应用用默认可见性。
    #[serde(rename = "visibleApps")]
    pub visible_apps: HashMap<String, bool>,
    /// 各应用配置目录覆盖（绝对路径）。未列出的应用用默认目录。
    #[serde(rename = "configDirs")]
    pub config_dirs: HashMap<String, String>,
    /// 切换供应商时是否同步官方 cc-switch 数据库的「当前」标记。
    #[serde(rename = "syncCcSwitchDb")]
    pub sync_cc_switch_db: bool,
}

impl Default for CcsSettings {
    fn default() -> Self {
        Self {
            visible_apps: HashMap::new(),
            config_dirs: HashMap::new(),
            sync_cc_switch_db: false,
        }
    }
}

impl CcsSettings {
    /// 应用是否在主页面可见（未显式设置时用应用默认值）。
    pub fn is_visible(&self, app: AppType) -> bool {
        self.visible_apps
            .get(app.as_str())
            .copied()
            .unwrap_or_else(|| app.meta().default_visible)
    }

    /// 设置应用可见性。
    pub fn set_visible(&mut self, app: AppType, visible: bool) {
        self.visible_apps.insert(app.as_str().to_string(), visible);
    }

    /// 返回当前可见的应用列表（按展示顺序）。
    pub fn visible_apps(&self) -> Vec<AppType> {
        AppType::ALL
            .into_iter()
            .filter(|app| self.is_visible(*app))
            .collect()
    }

    /// 应用配置目录覆盖（绝对路径）。
    pub fn config_dir_override(&self, app: AppType) -> Option<String> {
        self.config_dirs
            .get(app.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }

    /// 设置应用配置目录覆盖；传 `None` 或空字符串则清除（恢复默认）。
    pub fn set_config_dir_override(&mut self, app: AppType, dir: Option<String>) {
        match dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            Some(path) => {
                self.config_dirs.insert(app.as_str().to_string(), path);
            }
            None => {
                self.config_dirs.remove(app.as_str());
            }
        }
    }

    /// 保证至少一个应用可见：若全部被关闭，则强制开启指定的兜底应用。
    pub fn ensure_at_least_one_visible(&mut self) {
        if self.visible_apps().is_empty() {
            self.set_visible(AppType::Claude, true);
        }
    }
}

/// 读取当前 CCS 设置（从 config.json）。
pub fn load() -> CcsSettings {
    crate::config::load().ccs
}

/// 保存 CCS 设置（写回 config.json，保留其他字段）。
pub fn save(settings: &CcsSettings) -> Result<(), String> {
    let mut config = crate::config::load();
    config.ccs = settings.clone();
    crate::config::save(&config)
}

/// 启动时补齐 `visibleApps` 中缺失的应用（首次运行会写入一份完整默认值）。
///
/// 可见性未设置时 [`CcsSettings::is_visible`] 会回退到应用默认值，所以功能上不写
/// 也能用；但 config.json 里会一直缺这个键，用户看不出默认状态。这里把每个应用的
/// 当前默认可见性显式落盘（幂等，已有键不动）。
pub fn ensure_initialized() {
    let mut settings = load();
    if fill_missing_visible(&mut settings) {
        let _ = save(&settings);
    }
}

/// 为 `visibleApps` 里缺失的应用补上默认可见性；有改动返回 `true`。
fn fill_missing_visible(settings: &mut CcsSettings) -> bool {
    let mut changed = false;
    for app in AppType::ALL {
        if !settings.visible_apps.contains_key(app.as_str()) {
            settings
                .visible_apps
                .insert(app.as_str().to_string(), app.meta().default_visible);
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_default_visibility() {
        let settings = CcsSettings::default();
        assert!(settings.is_visible(AppType::Claude));
        assert!(!settings.is_visible(AppType::Hermes));
    }

    #[test]
    fn explicit_visibility_overrides_default() {
        let mut settings = CcsSettings::default();
        settings.set_visible(AppType::Hermes, true);
        settings.set_visible(AppType::Claude, false);
        assert!(settings.is_visible(AppType::Hermes));
        assert!(!settings.is_visible(AppType::Claude));
    }

    #[test]
    fn config_dir_override_set_and_clear() {
        let mut settings = CcsSettings::default();
        assert_eq!(settings.config_dir_override(AppType::Claude), None);
        settings.set_config_dir_override(AppType::Claude, Some("  /x/y  ".into()));
        assert_eq!(
            settings.config_dir_override(AppType::Claude),
            Some("/x/y".into())
        );
        settings.set_config_dir_override(AppType::Claude, Some("  ".into()));
        assert_eq!(settings.config_dir_override(AppType::Claude), None);
    }

    #[test]
    fn ensures_one_visible() {
        let mut settings = CcsSettings::default();
        for app in AppType::ALL {
            settings.set_visible(app, false);
        }
        settings.ensure_at_least_one_visible();
        assert!(!settings.visible_apps().is_empty());
    }

    #[test]
    fn fill_missing_visible_adds_every_app_with_defaults() {
        let mut settings = CcsSettings::default();
        assert!(fill_missing_visible(&mut settings));
        for app in AppType::ALL {
            assert_eq!(
                settings.visible_apps.get(app.as_str()),
                Some(&app.meta().default_visible),
                "{} missing",
                app.as_str()
            );
        }
        // 幂等：再跑一次没有改动。
        assert!(!fill_missing_visible(&mut settings));
    }

    #[test]
    fn fill_missing_visible_keeps_existing_choices() {
        let mut settings = CcsSettings::default();
        settings.set_visible(AppType::Claude, false);
        fill_missing_visible(&mut settings);
        // 用户已设置的值不被覆盖。
        assert!(!settings.is_visible(AppType::Claude));
        assert!(settings.visible_apps.contains_key(AppType::Hermes.as_str()));
    }
}
