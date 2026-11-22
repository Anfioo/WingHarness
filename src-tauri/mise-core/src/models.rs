// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseHealthLevel {
    Healthy,
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseRuntimeSource {
    Path,
    Scoop,
    Direct,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseShimState {
    Present,
    Missing,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseShimStatus {
    pub state: MiseShimState,
    pub directory: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseRuntimeInfo {
    pub available: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub source: Option<MiseRuntimeSource>,
    /// A command to paste into a terminal, not prose. Example: `winget install jdx.mise`.
    pub install_hint: String,
    pub detail: Option<String>,
    pub shims: Option<MiseShimStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseSignalCode {
    Runtime,
    ActiveTools,
    PathExport,
    JavaHome,
    ConfigSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseEnvironmentSignal {
    pub code: MiseSignalCode,
    pub level: MiseHealthLevel,
    pub value: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MiseSystemInfo {
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub kernel_version: Option<String>,
    pub host_name: Option<String>,
    pub arch: String,
    pub cpu_count: usize,
    pub cpu_brand: Option<String>,
    pub memory_total_bytes: u64,
    pub memory_available_bytes: u64,
    pub disk_total_bytes: Option<u64>,
    pub disk_available_bytes: Option<u64>,
    pub disk_mount: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MiseToolSummaryCounts {
    pub installed_tool_count: usize,
    pub active_tool_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MiseProjectSummary {
    pub project_count: usize,
    pub declared_tool_count: usize,
    pub override_project_count: usize,
    pub override_binding_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MiseVersionInfo {
    pub version: Option<String>,
    pub executable: Option<String>,
    pub source: Option<MiseRuntimeSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseDashboard {
    pub runtime: MiseRuntimeInfo,
    pub system: MiseSystemInfo,
    pub tool_summary: MiseToolSummaryCounts,
    pub project_summary: MiseProjectSummary,
    pub version_info: MiseVersionInfo,
    pub signals: Vec<MiseEnvironmentSignal>,
    pub recent_history: Vec<MiseHistoryEntry>,
    pub notices: Vec<MiseNotice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseToolSourceKind {
    Global,
    Project,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseRemoteState {
    Pending,
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseImpactReason {
    Global,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseToolActionKind {
    Upgrade,
    InspectSource,
    ShowCurrent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseNoticeCode {
    WindowsShimMissing,
    RemoteUnavailable,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseNotice {
    pub code: MiseNoticeCode,
    pub level: MiseHealthLevel,
    pub detail: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseInstalledVersion {
    pub version: String,
    pub requested_version: Option<String>,
    pub install_path: Option<String>,
    pub installed: bool,
    pub active: bool,
    pub source_kind: MiseToolSourceKind,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseToolProjectImpact {
    pub project_name: String,
    pub path: String,
    pub requested_version: String,
    pub resolved_version: String,
    pub reason: MiseImpactReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseToolAction {
    pub kind: MiseToolActionKind,
    pub command: String,
    pub level: MiseHealthLevel,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseRemoteVersion {
    pub version: String,
    pub rolling: bool,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseTool {
    pub id: String,
    pub name: String,
    pub active_version: String,
    pub requested_version: String,
    pub source_kind: MiseToolSourceKind,
    pub source_path: Option<String>,
    pub level: MiseHealthLevel,
    pub installed_versions: Vec<MiseInstalledVersion>,
    pub project_impacts: Vec<MiseToolProjectImpact>,
    pub quick_actions: Vec<MiseToolAction>,
    pub command_preview: String,
    pub update_version: Option<String>,
    pub latest_stable_version: Option<String>,
    pub latest_preview_version: Option<String>,
    pub remote_versions: Vec<MiseRemoteVersion>,
    pub remote_state: MiseRemoteState,
    pub notices: Vec<MiseNotice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseHistoryStatus {
    Success,
    Failure,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseHistoryEntry {
    pub id: String,
    /// Unix milliseconds.
    pub timestamp_ms: i64,
    pub command: String,
    /// English diagnostic text; the UI localizes around it.
    pub detail: String,
    pub level: MiseHealthLevel,
    pub status: MiseHistoryStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub stdout_snippet: Option<String>,
    pub stderr_snippet: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseOutputSource {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseOutputChunk {
    pub source: MiseOutputSource,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseExecutedCommand {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseLockfileReport {
    pub removed_paths: Vec<String>,
    pub failed_paths: Vec<String>,
    pub detected_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseActionResult {
    pub script: String,
    pub commands: Vec<MiseExecutedCommand>,
    pub lockfile_cleanup: Option<MiseLockfileReport>,
}

impl MiseActionResult {
    /// True when every command exited with code 0.
    pub fn is_success(&self) -> bool {
        self.commands.iter().all(|command| command.exit_code == 0)
    }

    /// The first non-zero exit code, or 0 when everything succeeded.
    pub fn exit_code(&self) -> i32 {
        self.commands
            .iter()
            .find(|command| command.exit_code != 0)
            .map(|command| command.exit_code)
            .unwrap_or(0)
    }

    /// The sum of every command's own duration.
    pub fn duration_ms(&self) -> u64 {
        self.commands.iter().map(|command| command.duration_ms).sum()
    }

    pub fn stdout(&self) -> String {
        join_output(self.commands.iter().map(|command| command.stdout.as_str()))
    }

    pub fn stderr(&self) -> String {
        join_output(self.commands.iter().map(|command| command.stderr.as_str()))
    }

    pub fn stdout_snippet(&self) -> Option<String> {
        snippet(self.commands.iter().map(|command| command.stdout.as_str()))
    }

    pub fn stderr_snippet(&self) -> Option<String> {
        snippet(self.commands.iter().map(|command| command.stderr.as_str()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseActionProgressKind {
    CommandStarted,
    Output,
    CommandFinished,
    LockfileCleanup,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseActionProgress {
    pub kind: MiseActionProgressKind,
    pub command: String,
    pub command_index: usize,
    pub total_commands: usize,
    pub output: Option<String>,
    pub output_source: Option<MiseOutputSource>,
    pub exit_code: Option<i32>,
    pub lockfile_cleanup: Option<MiseLockfileReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseScanDirectory {
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseProjectNotes {
    Overrides,
    ProjectOnly,
    None,
    Consistent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseProjectScanIssue {
    NotTrusted,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MiseBindingSource {
    Project,
    ProjectFile,
    Global,
    Inherited,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseProjectBinding {
    pub name: String,
    pub project_version: String,
    pub global_version: String,
    pub source: MiseBindingSource,
    pub source_file: Option<String>,
    pub declared_in_project: bool,
    pub declared_in_global: bool,
    pub overrides_global: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseProject {
    pub name: String,
    pub path: String,
    pub scan_root_path: String,
    pub config_path: String,
    pub config_paths: Vec<String>,
    pub tools: Vec<String>,
    pub last_modified_ms: Option<i64>,
    pub command_preview: String,
    pub bindings: Vec<MiseProjectBinding>,
    pub level: MiseHealthLevel,
    pub declared_tool_count: usize,
    pub override_count: usize,
    pub project_only_tool_count: usize,
    pub notes: MiseProjectNotes,
    pub scan_issue: Option<MiseProjectScanIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseProjectCoverage {
    pub opened_projects: Vec<String>,
    pub scan_directories: Vec<MiseScanDirectory>,
    pub projects: Vec<MiseProject>,
    pub notices: Vec<MiseNotice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseConfigDocumentKind {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigDocument {
    pub kind: MiseConfigDocumentKind,
    pub path: String,
    pub content: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigProjectRef {
    pub path: String,
    pub name: String,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigToolEntry {
    pub tool: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigToolsSection {
    pub kind: MiseConfigDocumentKind,
    pub entries: Vec<MiseConfigToolEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MiseConfigValueType {
    String,
    Integer,
    Boolean,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigRuntimeSetting {
    pub key: String,
    pub value_type: MiseConfigValueType,
    pub value: String,
    pub default_value: String,
    pub is_set: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigRuntimeSettings {
    pub path: String,
    pub settings: Vec<MiseConfigRuntimeSetting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigProxySetting {
    pub key: String,
    pub value: String,
    pub placeholder: String,
    pub is_set: bool,
    pub requires_uri: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigProxySettings {
    pub path: String,
    pub settings: Vec<MiseConfigProxySetting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigAlias {
    pub alias: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigWorkspace {
    pub documents: Vec<MiseConfigDocument>,
    pub project: Option<MiseConfigProjectRef>,
    pub tools_sections: Vec<MiseConfigToolsSection>,
    pub runtime_settings: MiseConfigRuntimeSettings,
    pub proxy_settings: MiseConfigProxySettings,
    pub java_aliases: Vec<MiseConfigAlias>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MiseConfigEdit {
    Document {
        content: String,
    },
    Settings {
        values: std::collections::BTreeMap<String, Option<String>>,
    },
    Proxy {
        values: std::collections::BTreeMap<String, Option<String>>,
    },
    Aliases {
        values: std::collections::BTreeMap<String, Option<String>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigSavePreview {
    pub path: String,
    pub exists: bool,
    pub current_content: String,
    pub next_content: String,
    pub diff: String,
    pub has_changes: bool,
    pub creates_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiseConfigSaveResult {
    pub path: String,
    pub backup_path: Option<String>,
    pub bytes_written: u64,
    pub created: bool,
}

fn join_output<'a>(parts: impl Iterator<Item = &'a str>) -> String {
    parts
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The first three lines of the last non-empty output, or `None`.
fn snippet<'a>(parts: impl Iterator<Item = &'a str>) -> Option<String> {
    let text = parts.filter(|part| !part.trim().is_empty()).last()?;
    let lines = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}
