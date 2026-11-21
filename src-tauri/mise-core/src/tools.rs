// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Installed tools, their source files and the remote versions behind the
//! detail view.
//!
//! `mise ls --json` is the only source of truth for the list; the detail view
//! re-reads it for one tool, then asks the registry for candidate versions.
//! Python reports its newest stable release through `mise outdated`, every
//! other backend is asked with `mise ls-remote --json` and a 90-second budget.
//! A failed remote lookup degrades to the outdated entry plus a notice instead
//! of an error, because the installed list is still accurate.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{MiseError, MiseErrorCode, MiseResult};
use crate::models::{
    MiseHealthLevel, MiseImpactReason, MiseInstalledVersion, MiseNotice, MiseNoticeCode,
    MiseRemoteState, MiseRemoteVersion, MiseShimState, MiseTool, MiseToolAction,
    MiseToolActionKind, MiseToolProjectImpact, MiseToolSourceKind,
};
use crate::{process, runtime, MiseState};

/// `mise ls --json` is a local read; a minute is already generous.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// `mise outdated --json` reads the local database plus a cached registry.
const OUTDATED_TIMEOUT: Duration = Duration::from_secs(30);
/// `mise ls-remote --json` talks to the backend's registry.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(90);

/// One installed version as `mise ls --json` reports it.
#[derive(Debug, Deserialize)]
struct InstalledVersionJson {
    #[serde(default)]
    version: String,
    #[serde(default)]
    requested_version: Option<String>,
    #[serde(default)]
    install_path: Option<String>,
    #[serde(default)]
    installed: Option<bool>,
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    source: Option<SourceJson>,
}

#[derive(Debug, Deserialize)]
struct SourceJson {
    #[serde(rename = "type", default)]
    source_type: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

/// One remote version as `mise ls-remote --json` reports it. Older mise
/// releases omit `rolling` and `created_at`.
#[derive(Debug, Deserialize)]
struct RemoteVersionJson {
    #[serde(default)]
    version: String,
    #[serde(default)]
    rolling: bool,
    #[serde(default)]
    created_at: Option<String>,
}

/// Every tool `mise ls --json` reports, with the active version selected.
pub async fn list_tools() -> MiseResult<Vec<MiseTool>> {
    let installed = load_installed_tools().await?;
    let shim_missing = windows_shim_missing().await;

    let mut tools: Vec<MiseTool> = installed
        .iter()
        .filter_map(|(id, versions)| build_tool(id, versions, shim_missing))
        .collect();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(tools)
}

/// One tool with its remote versions loaded on demand.
pub async fn tool_detail(state: &MiseState, tool: &str) -> MiseResult<MiseTool> {
    let cancel = state.register_detail_cancel(tool);
    let result = tool_detail_inner(tool, cancel).await;
    // Always drop the registration, including on the error and cancellation
    // paths, so a stale token cannot cancel a later request.
    state.finish_detail_cancel(tool);
    result
}

/// Cancel a running detail request for one tool.
pub async fn tool_detail_cancel(state: &MiseState, tool: &str) -> MiseResult<()> {
    if state.cancel_detail(tool) {
        Ok(())
    } else {
        Err(MiseError::not_found(
            "No detail request is running for this tool.",
        ))
    }
}

async fn tool_detail_inner(tool: &str, cancel: CancellationToken) -> MiseResult<MiseTool> {
    let installed = load_installed_tools().await?;
    let versions = installed
        .get(tool)
        .ok_or_else(|| MiseError::not_found("The requested tool is not managed by mise."))?;

    let shim_missing = windows_shim_missing().await;
    let mut record = build_tool(tool, versions, shim_missing)
        .ok_or_else(|| MiseError::not_found("The requested tool has no versions."))?;

    let active_version = record.active_version.clone();
    let requested_version = record.requested_version.clone();
    let mut notices = record.notices.clone();
    let mut outdated_latest: Option<String> = None;
    let mut remote_versions: Vec<MiseRemoteVersion> = Vec::new();

    if tool == "python" {
        match fetch_outdated_latest(tool).await {
            Ok(Some(latest)) if compare_versions(&latest, &active_version) == Ordering::Greater => {
                remote_versions.push(MiseRemoteVersion {
                    version: latest.clone(),
                    rolling: false,
                    created_at: None,
                });
                outdated_latest = Some(latest);
            }
            Ok(_) => {}
            Err(error) => log::debug!("mise_outdated_lookup_failed tool={tool} error={error}"),
        }
    } else {
        match fetch_remote_versions(tool, cancel.clone()).await {
            Ok(versions) => remote_versions = versions,
            Err(error) if error.code == MiseErrorCode::Cancelled => {
                return Err(MiseError::cancelled());
            }
            Err(error) => {
                log::warn!("mise_remote_versions_failed tool={tool} error={error}");
                notices.push(MiseNotice {
                    code: MiseNoticeCode::RemoteUnavailable,
                    level: MiseHealthLevel::Warning,
                    detail: Some(error.message),
                    command: Some(format!("mise ls-remote --json {tool}")),
                });
                match fetch_outdated_latest(tool).await {
                    Ok(latest) => outdated_latest = latest,
                    Err(fallback_error) => log::debug!(
                        "mise_outdated_fallback_failed tool={tool} error={fallback_error}"
                    ),
                }
            }
        }
    }

    let candidates = filter_remote_candidates(tool, &requested_version, &remote_versions);
    let update_version =
        resolve_update_version(&active_version, outdated_latest.as_deref(), &candidates);
    let latest_stable_version = update_version
        .clone()
        .or_else(|| candidates.first().map(|version| version.version.clone()))
        .or_else(|| outdated_latest.clone())
        .or_else(|| Some(active_version.clone()));
    let latest_preview_version = candidates
        .last()
        .map(|version| version.version.clone())
        .or_else(|| latest_stable_version.clone())
        .or_else(|| Some(active_version.clone()));
    let remote_state =
        if !candidates.is_empty() || latest_stable_version.as_deref() != Some(&active_version) {
            MiseRemoteState::Ready
        } else {
            MiseRemoteState::Unavailable
        };

    let mut quick_actions = Vec::new();
    if let Some(update) = &update_version {
        let use_scope = if record.source_kind == MiseToolSourceKind::Global {
            "mise use --global"
        } else {
            "mise use"
        };
        quick_actions.push(MiseToolAction {
            kind: MiseToolActionKind::Upgrade,
            command: format!("mise install {tool}@{update}\n{use_scope} {tool}@{update}"),
            level: MiseHealthLevel::Healthy,
            version: Some(update.clone()),
        });
    }
    quick_actions.extend(record.quick_actions.clone());

    let level = if notices.is_empty() {
        if update_version.is_some() {
            MiseHealthLevel::Healthy
        } else {
            MiseHealthLevel::Info
        }
    } else {
        MiseHealthLevel::Warning
    };

    record.notices = notices;
    record.remote_versions = candidates;
    record.remote_state = remote_state;
    record.update_version = update_version;
    record.latest_stable_version = latest_stable_version;
    record.latest_preview_version = latest_preview_version;
    record.quick_actions = quick_actions;
    record.level = level;

    Ok(record)
}

/// Read `mise ls --json` into its per-tool version lists.
async fn load_installed_tools() -> MiseResult<BTreeMap<String, Vec<InstalledVersionJson>>> {
    let result = process::run_command(
        &["ls".to_string(), "--json".to_string()],
        None,
        LIST_TIMEOUT,
        true,
        None,
        None,
    )
    .await?;

    let stdout = result.stdout.trim();
    if stdout.is_empty() || stdout == "{}" || stdout == "null" {
        return Ok(BTreeMap::new());
    }

    let mut installed: BTreeMap<String, Vec<InstalledVersionJson>> = serde_json::from_str(stdout)
        .map_err(|error| {
        log::warn!("mise_tool_list_parse_failed error={error}");
        MiseError::internal("The mise tool list could not be parsed.")
    })?;
    for versions in installed.values_mut() {
        versions.retain(|version| !version.version.trim().is_empty());
    }
    installed.retain(|_, versions| !versions.is_empty());
    Ok(installed)
}

/// Build one tool from its installed versions. Returns `None` when the tool has
/// no usable version at all.
fn build_tool(id: &str, versions: &[InstalledVersionJson], shim_missing: bool) -> Option<MiseTool> {
    let active = versions
        .iter()
        .find(|version| version.active.unwrap_or(false))
        .or_else(|| versions.first())?;

    let (source_kind, source_path) = source_for(active.source.as_ref());
    let active_version = active.version.clone();
    let requested_version = active
        .requested_version
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| active_version.clone());

    let installed_versions = versions
        .iter()
        .map(|version| {
            let (version_kind, version_path) = source_for(version.source.as_ref());
            MiseInstalledVersion {
                version: version.version.clone(),
                requested_version: version.requested_version.clone(),
                install_path: version.install_path.clone(),
                installed: version.installed.unwrap_or(false),
                active: version.active.unwrap_or(false),
                source_kind: version_kind,
                source_path: version_path,
            }
        })
        .collect();

    let project_impacts: Vec<MiseToolProjectImpact> = source_path
        .as_ref()
        .map(|path| {
            vec![MiseToolProjectImpact {
                project_name: impact_name(source_kind, path),
                path: path.clone(),
                requested_version: requested_version.clone(),
                resolved_version: active_version.clone(),
                reason: if source_kind == MiseToolSourceKind::Global {
                    MiseImpactReason::Global
                } else {
                    MiseImpactReason::Project
                },
            }]
        })
        .unwrap_or_default();

    let mut notices = Vec::new();
    if shim_missing {
        notices.push(MiseNotice {
            code: MiseNoticeCode::WindowsShimMissing,
            level: MiseHealthLevel::Warning,
            detail: Some(
                "The mise shim directory is not on PATH; new cmd or PowerShell sessions cannot call mise-managed tools directly."
                    .to_string(),
            ),
            command: Some("mise reshim".to_string()),
        });
    }

    let quick_actions = vec![
        MiseToolAction {
            kind: MiseToolActionKind::ShowCurrent,
            command: format!("mise current {id}"),
            level: MiseHealthLevel::Info,
            version: None,
        },
        MiseToolAction {
            kind: MiseToolActionKind::InspectSource,
            command: format!("mise ls --json\nmise which {id}"),
            level: MiseHealthLevel::Info,
            version: None,
        },
    ];
    let command_preview = format!("mise current {id}\nmise ls --json\nmise which {id}");

    Some(MiseTool {
        id: id.to_string(),
        name: tool_display_name(id),
        active_version,
        requested_version,
        source_kind,
        source_path,
        level: if source_kind == MiseToolSourceKind::Unknown {
            MiseHealthLevel::Warning
        } else {
            MiseHealthLevel::Info
        },
        installed_versions,
        project_impacts,
        quick_actions,
        command_preview,
        update_version: None,
        latest_stable_version: None,
        latest_preview_version: None,
        remote_versions: Vec::new(),
        remote_state: MiseRemoteState::Pending,
        notices,
    })
}

/// Classify one `source` block. A `mise.toml` under `.config/mise` is the
/// user's global configuration; any other path belongs to a project.
fn source_for(source: Option<&SourceJson>) -> (MiseToolSourceKind, Option<String>) {
    let Some(source) = source else {
        return (MiseToolSourceKind::Unknown, None);
    };
    let Some(path) = source
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return (MiseToolSourceKind::Unknown, None);
    };

    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let kind = if source.source_type.as_deref() == Some("mise.toml")
        && normalized.contains(".config/mise/")
    {
        MiseToolSourceKind::Global
    } else {
        MiseToolSourceKind::Project
    };
    (kind, Some(path.to_string()))
}

/// A readable project name for the impact row: the global configuration file
/// has no project, and a project file is named after its directory.
fn impact_name(kind: MiseToolSourceKind, path: &str) -> String {
    if kind == MiseToolSourceKind::Global {
        return "Global config".to_string();
    }
    let normalized = path.replace('\\', "/");
    let parent = normalized
        .trim_end_matches('/')
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or_default();
    parent
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

async fn fetch_remote_versions(
    tool: &str,
    cancel: CancellationToken,
) -> MiseResult<Vec<MiseRemoteVersion>> {
    let result = process::run_command(
        &[
            "ls-remote".to_string(),
            "--json".to_string(),
            tool.to_string(),
        ],
        None,
        REMOTE_TIMEOUT,
        false,
        Some(cancel),
        None,
    )
    .await?;

    let stdout = result.stdout.trim();
    if stdout.is_empty() || stdout == "[]" {
        return Ok(Vec::new());
    }

    let raw: Vec<RemoteVersionJson> = serde_json::from_str(stdout).map_err(|error| {
        log::warn!("mise_remote_versions_parse_failed tool={tool} error={error}");
        MiseError::internal("The remote version list could not be parsed.")
    })?;

    Ok(raw
        .into_iter()
        .filter(|version| !version.version.trim().is_empty())
        .map(|version| MiseRemoteVersion {
            version: version.version,
            rolling: version.rolling,
            created_at: version.created_at,
        })
        .collect())
}

/// `mise outdated --json` names the newest stable release for the active
/// version line; a backend without a matching entry has no answer.
async fn fetch_outdated_latest(tool: &str) -> MiseResult<Option<String>> {
    let result = process::run_command(
        &["outdated".to_string(), "--json".to_string()],
        None,
        OUTDATED_TIMEOUT,
        true,
        None,
        None,
    )
    .await?;

    let stdout = result.stdout.trim();
    if stdout.is_empty() || stdout == "{}" || stdout == "null" {
        return Ok(None);
    }

    let value: Value = serde_json::from_str(stdout).map_err(|error| {
        log::warn!("mise_outdated_parse_failed error={error}");
        MiseError::internal("The outdated version list could not be parsed.")
    })?;
    Ok(value
        .get(tool)
        .and_then(|entry| entry.get("latest"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|latest| !latest.is_empty())
        .map(str::to_string))
}

/// A missing Windows shim directory is a warning on every tool, not a reason to
/// fail the list. The probe runs at most once per request.
async fn windows_shim_missing() -> bool {
    if !cfg!(windows) {
        return false;
    }
    match runtime::probe_runtime().await {
        Ok(info) => info
            .shims
            .as_ref()
            .is_some_and(|shims| shims.state == MiseShimState::Missing),
        Err(error) => {
            log::debug!("mise_shim_probe_failed error={error}");
            false
        }
    }
}

/// Remote candidates as the detail view shows them: scoped by tool and
/// requested major, newest first, at most four.
pub(crate) fn filter_remote_candidates(
    tool: &str,
    requested_version: &str,
    versions: &[MiseRemoteVersion],
) -> Vec<MiseRemoteVersion> {
    let requested_major = leading_major(requested_version);
    let non_rolling: Vec<&MiseRemoteVersion> =
        versions.iter().filter(|version| !version.rolling).collect();

    let scoped: Vec<MiseRemoteVersion> = if tool == "java" {
        match &requested_major {
            Some(major) => non_rolling
                .iter()
                .filter(|version| {
                    leading_major(&version.version).as_deref() == Some(major.as_str())
                        && !is_java_runtime_only(&version.version)
                })
                .map(|version| (*version).clone())
                .collect(),
            None => non_rolling
                .iter()
                .map(|version| (*version).clone())
                .collect(),
        }
    } else if tool == "flutter" {
        let stable: Vec<MiseRemoteVersion> = non_rolling
            .iter()
            .filter(|version| version.version.to_ascii_lowercase().contains("stable"))
            .map(|version| (*version).clone())
            .collect();
        if stable.is_empty() {
            non_rolling
                .iter()
                .map(|version| (*version).clone())
                .collect()
        } else {
            stable
        }
    } else if let Some(major) = requested_major {
        let prefix = format!("{major}.");
        non_rolling
            .iter()
            .filter(|version| version.version.starts_with(&prefix))
            .map(|version| (*version).clone())
            .collect()
    } else {
        non_rolling
            .iter()
            .map(|version| (*version).clone())
            .collect()
    };

    let mut sorted = scoped;
    sorted.sort_by(|left, right| compare_versions(&left.version, &right.version));
    let tail = if sorted.len() <= 4 {
        sorted
    } else {
        sorted.split_off(sorted.len() - 4)
    };
    tail.into_iter().rev().collect()
}

/// The version the upgrade action should target: the outdated entry first, then
/// the newest candidate, and nothing when neither is newer than the active one.
pub(crate) fn resolve_update_version(
    active_version: &str,
    outdated_latest: Option<&str>,
    candidates: &[MiseRemoteVersion],
) -> Option<String> {
    if let Some(latest) = outdated_latest {
        if compare_versions(latest, active_version) == Ordering::Greater {
            return Some(latest.to_string());
        }
    }

    let newest = candidates.first()?;
    if compare_versions(&newest.version, active_version) == Ordering::Greater {
        Some(newest.version.clone())
    } else {
        None
    }
}

/// Compare two versions token by token. Numeric tokens compare by value, text
/// tokens sort after numbers, and a missing trailing token counts as zero so
/// `1.0.0` equals `1`.
pub(crate) fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_tokens = tokenize_version(left);
    let right_tokens = tokenize_version(right);
    let limit = left_tokens.len().max(right_tokens.len());

    for index in 0..limit {
        match (left_tokens.get(index), right_tokens.get(index)) {
            (Some(left_token), Some(right_token)) => {
                match compare_tokens(left_token, right_token) {
                    Ordering::Equal => continue,
                    other => return other,
                }
            }
            (None, Some(_)) => {
                return if remaining_is_zero(&right_tokens, index) {
                    Ordering::Equal
                } else {
                    Ordering::Less
                };
            }
            (Some(_), None) => {
                return if remaining_is_zero(&left_tokens, index) {
                    Ordering::Equal
                } else {
                    Ordering::Greater
                };
            }
            (None, None) => break,
        }
    }

    Ordering::Equal
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VersionToken {
    Numeric(u128),
    Text(String),
}

fn tokenize_version(version: &str) -> Vec<VersionToken> {
    let bytes = version.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_digit() {
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            let digits = &version[start..index];
            tokens.push(match digits.parse::<u128>() {
                Ok(value) => VersionToken::Numeric(value),
                Err(_) => VersionToken::Text(digits.to_ascii_lowercase()),
            });
        } else if byte.is_ascii_alphabetic() {
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                index += 1;
            }
            tokens.push(VersionToken::Text(
                version[start..index].to_ascii_lowercase(),
            ));
        } else {
            index += 1;
        }
    }

    tokens
}

fn compare_tokens(left: &VersionToken, right: &VersionToken) -> Ordering {
    match (left, right) {
        (VersionToken::Numeric(left), VersionToken::Numeric(right)) => left.cmp(right),
        (VersionToken::Numeric(_), VersionToken::Text(_)) => Ordering::Less,
        (VersionToken::Text(_), VersionToken::Numeric(_)) => Ordering::Greater,
        (VersionToken::Text(left), VersionToken::Text(right)) => left.cmp(right),
    }
}

fn remaining_is_zero(tokens: &[VersionToken], start: usize) -> bool {
    tokens[start..]
        .iter()
        .all(|token| matches!(token, VersionToken::Numeric(0)))
}

pub(crate) fn leading_major(input: &str) -> Option<String> {
    let mut digits = String::new();
    for character in input.chars() {
        if character.is_ascii_digit() {
            digits.push(character);
        } else if !digits.is_empty() {
            break;
        }
    }
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

fn is_java_runtime_only(version: &str) -> bool {
    let normalized = version.to_ascii_lowercase();
    normalized.contains("-jre") || normalized.contains("+jre")
}

fn tool_display_name(id: &str) -> String {
    match id {
        "go" => "Go".to_string(),
        "java" => "Java".to_string(),
        "python" => "Python".to_string(),
        "flutter" => "Flutter".to_string(),
        "node" => "Node".to_string(),
        "ruby" => "Ruby".to_string(),
        "terraform" => "Terraform".to_string(),
        _ => {
            let mut characters = id.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => String::new(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(version: &str) -> MiseRemoteVersion {
        MiseRemoteVersion {
            version: version.to_string(),
            rolling: false,
            created_at: None,
        }
    }

    fn rolling(version: &str) -> MiseRemoteVersion {
        MiseRemoteVersion {
            version: version.to_string(),
            rolling: true,
            created_at: None,
        }
    }

    #[test]
    fn numeric_version_parts_compare_by_value() {
        assert_eq!(compare_versions("1.2", "1.10"), Ordering::Less);
        assert_eq!(compare_versions("1.10", "1.2"), Ordering::Greater);
        assert_eq!(compare_versions("26.13.1", "26.13.10"), Ordering::Less);
    }

    #[test]
    fn missing_trailing_zero_parts_are_equal() {
        assert_eq!(compare_versions("1.0.0", "1"), Ordering::Equal);
        assert_eq!(compare_versions("1", "1.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.1", "1"), Ordering::Greater);
    }

    #[test]
    fn a_release_sorts_before_its_candidates() {
        assert_eq!(compare_versions("20.0.0", "20.0.0-rc1"), Ordering::Less);
        assert_eq!(compare_versions("20.0.0-rc1", "20.0.0"), Ordering::Greater);
    }

    #[test]
    fn text_parts_compare_lexicographically_after_numbers() {
        assert_eq!(
            compare_versions("temurin-21.0.3", "zulu-17.0.0"),
            Ordering::Less
        );
        assert_eq!(compare_versions("beta", "stable"), Ordering::Less);
    }

    #[test]
    fn leading_major_finds_the_first_digit_run() {
        assert_eq!(leading_major("26.13.1"), Some("26".to_string()));
        assert_eq!(leading_major("temurin-21.0.3"), Some("21".to_string()));
        assert_eq!(leading_major("stable"), None);
    }

    #[test]
    fn rolling_versions_are_dropped() {
        let versions = vec![rolling("27.0.0-alpha"), remote("26.13.1")];
        let selected = filter_remote_candidates("node", "", &versions);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].version, "26.13.1");
    }

    #[test]
    fn java_keeps_the_requested_major_and_drops_jre_builds() {
        let versions = vec![
            remote("temurin-21.0.2"),
            remote("temurin-21.0.1-jre"),
            remote("temurin-22.0.0"),
            remote("zulu-21.0.3"),
        ];
        let selected = filter_remote_candidates("java", "21", &versions);
        let versions: Vec<&str> = selected.iter().map(|item| item.version.as_str()).collect();
        assert_eq!(versions, vec!["zulu-21.0.3", "temurin-21.0.2"]);
    }

    #[test]
    fn flutter_prefers_stable_builds() {
        let versions = vec![remote("3.24.0"), remote("3.25.0-stable")];
        let selected = filter_remote_candidates("flutter", "", &versions);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].version, "3.25.0-stable");
    }

    #[test]
    fn a_requested_major_scopes_the_candidates() {
        let versions = vec![remote("18.20.4"), remote("20.16.0"), remote("20.17.0")];
        let selected = filter_remote_candidates("node", "18", &versions);
        let versions: Vec<&str> = selected.iter().map(|item| item.version.as_str()).collect();
        assert_eq!(versions, vec!["18.20.4"]);
    }

    #[test]
    fn only_the_newest_four_candidates_are_kept_newest_first() {
        let versions: Vec<MiseRemoteVersion> = (1..=6)
            .map(|minor| remote(&format!("1.{minor}.0")))
            .collect();
        let selected = filter_remote_candidates("node", "", &versions);
        let versions: Vec<&str> = selected.iter().map(|item| item.version.as_str()).collect();
        assert_eq!(versions, vec!["1.6.0", "1.5.0", "1.4.0", "1.3.0"]);
    }

    #[test]
    fn the_outdated_entry_wins_over_the_candidates() {
        let candidates = vec![remote("20.17.0")];
        assert_eq!(
            resolve_update_version("20.16.0", Some("20.18.0"), &candidates),
            Some("20.18.0".to_string())
        );
    }

    #[test]
    fn the_newest_candidate_is_the_fallback() {
        let candidates = vec![remote("20.18.0"), remote("20.17.0")];
        assert_eq!(
            resolve_update_version("20.16.0", None, &candidates),
            Some("20.18.0".to_string())
        );
    }

    #[test]
    fn no_newer_version_means_no_update() {
        let candidates = vec![remote("20.16.0")];
        assert_eq!(
            resolve_update_version("20.16.0", Some("20.15.0"), &candidates),
            None
        );
        assert_eq!(resolve_update_version("20.16.0", None, &[]), None);
    }

    #[test]
    fn a_global_config_source_is_classified_as_global() {
        let source = SourceJson {
            source_type: Some("mise.toml".to_string()),
            path: Some(r"C:\Users\me\.config\mise\config.toml".to_string()),
        };
        let (kind, path) = source_for(Some(&source));
        assert_eq!(kind, MiseToolSourceKind::Global);
        assert_eq!(
            path.as_deref(),
            Some(r"C:\Users\me\.config\mise\config.toml")
        );
    }

    #[test]
    fn a_project_toml_is_classified_as_project() {
        let source = SourceJson {
            source_type: Some("mise.toml".to_string()),
            path: Some("D:/work/app/mise.toml".to_string()),
        };
        assert_eq!(source_for(Some(&source)).0, MiseToolSourceKind::Project);
    }

    #[test]
    fn a_version_without_a_source_is_unknown() {
        assert_eq!(source_for(None), (MiseToolSourceKind::Unknown, None));
    }

    #[test]
    fn known_tools_have_a_display_name() {
        assert_eq!(tool_display_name("node"), "Node");
        assert_eq!(tool_display_name("terraform"), "Terraform");
        assert_eq!(tool_display_name("bun"), "Bun");
    }

    #[test]
    #[ignore = "requires a local mise install"]
    fn real_mise_lists_installed_tools() {
        let tools = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(list_tools())
            .expect("listing tools must not fail");

        for tool in tools {
            assert!(!tool.id.is_empty());
            assert_eq!(tool.remote_state, MiseRemoteState::Pending);
            assert!(tool.latest_stable_version.is_none());
        }
    }

    #[test]
    #[ignore = "requires a local mise install and network access"]
    fn real_mise_loads_remote_versions_for_a_tool() {
        let state = MiseState::default();
        let tools = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(list_tools())
            .expect("listing tools must not fail");
        let Some(first) = tools.first() else {
            return;
        };

        let detail = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(tool_detail(&state, &first.id))
            .expect("loading tool detail must not fail");

        assert_eq!(detail.id, first.id);
        assert!(detail.latest_stable_version.is_some());
    }
}
