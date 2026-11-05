//! 配置文件保序改写器。
//!
//! 统一用 [`PatchOp`] 描述「在某个键路径上设置或删除值」，各格式子模块负责
//! 把它应用到 JSON / TOML / YAML / ENV 内容上，尽量保留原文件的键顺序、注释
//! 和其他字段。

pub mod env_patch;
pub mod json_patch;
pub mod toml_patch;
pub mod yaml_patch;

use serde_json::Value;

use crate::ccs::app_type::ConfigFormat;

/// 单个配置改写操作。
#[derive(Debug, Clone)]
pub enum PatchOp {
    /// 在 `path` 处设置 `value`（中间层对象不存在则创建）。
    Set { path: Vec<String>, value: Value },
    /// 删除 `path` 处的键；不存在则忽略。
    Remove { path: Vec<String> },
}

impl PatchOp {
    /// 构造 Set 操作，路径用 `&str` 切片给出。
    pub fn set(path: &[&str], value: Value) -> Self {
        PatchOp::Set {
            path: path.iter().map(|s| s.to_string()).collect(),
            value,
        }
    }

    /// 构造 Remove 操作。
    pub fn remove(path: &[&str]) -> Self {
        PatchOp::Remove {
            path: path.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// 操作目标路径。
    pub fn path(&self) -> &[String] {
        match self {
            PatchOp::Set { path, .. } | PatchOp::Remove { path } => path,
        }
    }
}

/// 把字符串路径切片转成 owned Vec。
pub fn owned_path(path: &[&str]) -> Vec<String> {
    path.iter().map(|s| s.to_string()).collect()
}

/// 按格式把操作应用到文本上。
pub fn apply_for(format: ConfigFormat, contents: &str, ops: &[PatchOp]) -> Result<String, String> {
    match format {
        ConfigFormat::Json => json_patch::apply(contents, ops),
        ConfigFormat::Toml => toml_patch::apply(contents, ops),
        ConfigFormat::Yaml => yaml_patch::apply(contents, ops),
        ConfigFormat::Env => env_patch::apply(contents, ops),
    }
}

/// 按格式枚举 floor 删除操作。
pub fn floor_removals_for(
    format: ConfigFormat,
    contents: &str,
    is_floor: &dyn Fn(&[String]) -> bool,
) -> Vec<PatchOp> {
    match format {
        ConfigFormat::Json => json_patch::floor_removals(contents, is_floor),
        ConfigFormat::Toml => toml_patch::floor_removals(contents, is_floor),
        ConfigFormat::Yaml => yaml_patch::floor_removals(contents, is_floor),
        ConfigFormat::Env => env_patch::floor_removals(contents, is_floor),
    }
}
