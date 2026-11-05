//! Claude Code 专属的安装/集成开关。
//!
//! - 跳过初次安装确认：在 `~/.claude.json` 根写 `hasCompletedOnboarding=true`；
//! - Claude 插件集成：在 `<claude 配置目录>/config.json` 写 `primaryApiKey="any"`。
//!
//! 两者都是增量写入/删除单个字段，保留文件中的其他内容。

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::app_type::AppType;
use super::paths;

/// `~/.claude.json`（全局，固定主目录，不随配置目录覆盖变化）。
fn global_file() -> PathBuf {
    paths::claude_global_file()
}

/// `<claude 配置目录>/config.json`（随覆盖目录变化）。
fn plugin_config_file() -> PathBuf {
    paths::config_dir(AppType::Claude).join("config.json")
}

/// 读取某文件为 JSON 对象；文件不存在返回空对象。
fn read_object(path: &PathBuf) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let value: Value = serde_json::from_str(&content)
                .map_err(|e| format!("Invalid JSON at {}: {e}", path.display()))?;
            if value.is_object() {
                Ok(value)
            } else {
                Err(format!("{} root must be an object", path.display()))
            }
        }
        Err(_) => Ok(serde_json::json!({})),
    }
}

/// 原子写 JSON（pretty）。
fn write_object(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize JSON: {e}"))?;
    let tmp = path.with_extension("ccs.tmp");
    fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to replace {}: {e}", path.display()))
}

/// 在某文件设置布尔字段。
fn set_bool_field(path: &PathBuf, field: &str, flag: bool) -> Result<bool, String> {
    let mut value = read_object(path)?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| format!("{} root must be an object", path.display()))?;
    let already = obj.get(field).and_then(Value::as_bool).unwrap_or(false);
    if already == flag {
        return Ok(false);
    }
    obj.insert(field.to_string(), Value::Bool(flag));
    write_object(path, &value)?;
    Ok(true)
}

/// 删除某文件的字段。
fn remove_field(path: &PathBuf, field: &str) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let mut value = read_object(path)?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| format!("{} root must be an object", path.display()))?;
    if obj.remove(field).is_none() {
        return Ok(false);
    }
    write_object(path, &value)?;
    Ok(true)
}

/// 跳过 Claude Code 初次安装确认。
pub fn skip_onboarding() -> Result<(), String> {
    set_bool_field(&global_file(), "hasCompletedOnboarding", true).map(|_| ())
}

/// 恢复初次安装确认。
pub fn restore_onboarding() -> Result<(), String> {
    remove_field(&global_file(), "hasCompletedOnboarding").map(|_| ())
}

/// 是否已经跳过初次安装确认。
pub fn is_onboarding_skipped() -> bool {
    read_object(&global_file())
        .ok()
        .and_then(|v| v.get("hasCompletedOnboarding").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// 启用 Claude 插件集成。
pub fn enable_plugin_integration() -> Result<(), String> {
    let path = plugin_config_file();
    let mut value = read_object(&path)?;
    let obj = value.as_object_mut().ok_or("root must be an object")?;
    let current = obj
        .get("primaryApiKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if current == "any" {
        return Ok(());
    }
    obj.insert(
        "primaryApiKey".to_string(),
        Value::String("any".to_string()),
    );
    write_object(&path, &value)
}

/// 关闭 Claude 插件集成。
pub fn disable_plugin_integration() -> Result<(), String> {
    remove_field(&plugin_config_file(), "primaryApiKey").map(|_| ())
}

/// Claude 插件集成是否已启用。
pub fn is_plugin_integration_enabled() -> bool {
    let path = plugin_config_file();
    read_object(&path)
        .ok()
        .and_then(|v| {
            v.get("primaryApiKey")
                .and_then(Value::as_str)
                .map(|s| s == "any")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_config_file_under_claude_dir() {
        let p = plugin_config_file();
        assert!(p.to_string_lossy().contains(".claude"));
        assert!(p.file_name().unwrap() == "config.json");
    }

    #[test]
    fn read_missing_file_is_empty_object() {
        let v = read_object(&PathBuf::from("/nonexistent/xyz.json")).unwrap();
        assert!(v.is_object());
    }
}
