//! 各应用的供应商投影器。
//!
//! 每个应用提供两部分能力：
//! - [`is_floor_path`]：判断某目标文件中某个键路径是否为「关键字段」（连接/鉴权/
//!   模型，归供应商所有）。切换引擎读取现有配置后，用它生成清除操作。
//! - [`project`]：把供应商行（settings_config）翻译成一组「逻辑目标文件 + 操作」。
//!
//! 绝大多数应用只有 `main` 一个目标文件；Gemini 同时写 `settings`（settings.json）
//! 和 `env`（.env）。
//!
//! 设计为纯逻辑，不触碰文件系统，便于单元测试。

pub mod claude;
pub mod codex;
pub mod gemini;
pub mod grok;
pub mod hermes;
pub mod mcode;
pub mod openclaw;
pub mod opencode;
pub mod pi;

use crate::ccs::app_type::AppType;
use crate::ccs::patch::PatchOp;
use crate::ccs::provider::Provider;

/// 递归把 JSON 对象展开成「叶子路径 → set」操作。
///
/// 供 settings_config 直接就是目标文件结构的应用（Codex / Grok / Hermes 等）使用。
pub fn flatten_config(value: &serde_json::Value) -> Vec<PatchOp> {
    let mut ops = Vec::new();
    flatten_into(&[], value, &mut ops);
    ops
}

fn flatten_into(prefix: &[String], value: &serde_json::Value, ops: &mut Vec<PatchOp>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let mut path = prefix.to_vec();
                path.push(k.clone());
                flatten_into(&path, v, ops);
            }
        }
        other => {
            let path_ref: Vec<&str> = prefix.iter().map(|s| s.as_str()).collect();
            ops.push(PatchOp::set(&path_ref, other.clone()));
        }
    }
}

/// 一个逻辑目标文件上的投影操作。
#[derive(Debug, Clone)]
pub struct FileTarget {
    /// 逻辑目标文件标识（`main` / Gemini 的 `settings`、`env` / Codex 的 `auth`）。
    pub key: String,
    /// 该文件上的设置操作（`raw` 为 `Some` 时忽略）。
    pub ops: Vec<PatchOp>,
    /// 直接整写该文件的原始内容（如 Codex 的 auth.json）。
    pub raw: Option<String>,
}

impl FileTarget {
    pub fn main_target(ops: Vec<PatchOp>) -> Self {
        FileTarget {
            key: "main".to_string(),
            ops,
            raw: None,
        }
    }

    pub fn new(key: &str, ops: Vec<PatchOp>) -> Self {
        FileTarget {
            key: key.to_string(),
            ops,
            raw: None,
        }
    }

    /// 整写目标文件为 `content`（不做 floor 清除与合并）。
    pub fn raw(key: &str, content: String) -> Self {
        FileTarget {
            key: key.to_string(),
            ops: Vec::new(),
            raw: Some(content),
        }
    }
}

/// 判断某应用、某目标文件中，`path` 是否为关键字段（切换时应清除）。
pub fn is_floor_path(app: AppType, target_key: &str, path: &[String]) -> bool {
    match app {
        AppType::Claude => claude::is_floor_path(path),
        AppType::Codex => codex::is_floor_path(path),
        AppType::Gemini => gemini::is_floor_path(target_key, path),
        AppType::GrokBuild => grok::is_floor_path(path),
        AppType::OpenCode => opencode::is_floor_path(path),
        AppType::OpenClaw => openclaw::is_floor_path(path),
        AppType::Hermes => hermes::is_floor_path(path),
        AppType::Pi => pi::is_floor_path(path),
        AppType::Mcode => mcode::is_floor_path(path),
    }
}

/// 把供应商投影成一组目标文件操作。
pub fn project(app: AppType, provider: &Provider) -> Result<Vec<FileTarget>, String> {
    match app {
        AppType::Claude => Ok(vec![FileTarget::main_target(claude::project(provider)?)]),
        AppType::Codex => codex::project(provider),
        AppType::Gemini => gemini::project(provider),
        AppType::GrokBuild => Ok(vec![FileTarget::main_target(grok::project(provider)?)]),
        AppType::OpenCode => Ok(vec![FileTarget::main_target(opencode::project(provider)?)]),
        AppType::OpenClaw => Ok(vec![FileTarget::main_target(openclaw::project(provider)?)]),
        AppType::Hermes => Ok(vec![FileTarget::main_target(hermes::project(provider)?)]),
        AppType::Pi => Ok(vec![FileTarget::main_target(pi::project(provider)?)]),
        AppType::Mcode => Ok(vec![FileTarget::main_target(mcode::project(provider)?)]),
    }
}
