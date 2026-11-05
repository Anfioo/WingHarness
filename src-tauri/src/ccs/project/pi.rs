//! Pi 投影器（目标结构实施时按实际 CLI 确认）。
//!
//! 当前采用「settings_config 即目标配置片段」的递归展开方式。

use crate::ccs::patch::PatchOp;
use crate::ccs::project::flatten_config;
use crate::ccs::provider::Provider;

pub fn is_floor_path(_path: &[String]) -> bool {
    false
}

pub fn project(provider: &Provider) -> Result<Vec<PatchOp>, String> {
    Ok(flatten_config(&provider.settings_config))
}
