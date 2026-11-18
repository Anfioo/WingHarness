//! On-demand details for a single process (too costly to collect for all).

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub description: Option<String>,
    pub company: Option<String>,
    pub product_name: Option<String>,
    pub file_version: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetails {
    pub pid: u32,
    /// False when the process could not be opened (usually needs admin).
    pub accessible: bool,
    pub command_line: Option<String>,
    pub user: Option<String>,
    /// `untrusted` | `low` | `medium` | `mediumPlus` | `high` | `system` | `protected`
    pub integrity: Option<&'static str>,
    pub elevated: Option<bool>,
    /// `x64` | `x86` | `arm64` | `arm`
    pub architecture: Option<&'static str>,
    /// `idle` | `belowNormal` | `normal` | `aboveNormal` | `high` | `realtime`
    pub priority_class: Option<&'static str>,
    pub version: VersionInfo,
}

/// Query one process instance. A0 only freezes the signature; B3 replaces the
/// body with the ported token and image queries.
pub fn query(_pid: u32, _path: Option<&str>) -> ProcessDetails {
    todo!("process details are implemented by B3")
}
