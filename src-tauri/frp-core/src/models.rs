//! DTOs shared by the engine, the commands and the frontend.
//!
//! Everything serializes as camelCase JSON. Timestamps are Unix seconds. Token
//! and `secretKey` values are stored in plain text in `frp.json` by explicit
//! user decision; the UI masks them and logs/redact them on the way out.

use serde::{Deserialize, Serialize};

use crate::error::FrpError;

/// How a profile picks the `frpc` binary to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RuntimePolicy {
    /// Use a pinned record when valid, otherwise the newest installed runtime.
    #[default]
    Recommended,
    /// The profile must name a `runtimeId`; no fallback is attempted.
    Pinned,
}

/// A saved FRP server profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrpProfile {
    pub id: String,
    pub name: String,
    pub server_addr: String,
    pub server_port: u16,
    /// Plain text, as stored in `frp.json`; the UI masks it by default.
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub runtime_policy: RuntimePolicy,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub reconnect_enabled: bool,
    #[serde(default)]
    pub note: String,
    /// Bumped whenever the generated config changes; a running process whose
    /// snapshot carries an older revision is "restart to apply".
    #[serde(default)]
    pub config_revision: i64,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// The editable half of a profile, as the create/update form sends it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrpProfileInput {
    pub name: String,
    pub server_addr: String,
    pub server_port: u16,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub runtime_policy: RuntimePolicy,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub reconnect_enabled: bool,
    #[serde(default)]
    pub note: String,
}

/// The six tunnel types frpc understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelType {
    Tcp,
    Udp,
    Http,
    Https,
    Stcp,
    Xtcp,
}

/// The role a STCP/XTCP secret tunnel plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretRole {
    Server,
    Visitor,
}

/// Type-specific tunnel options, tagged by `kind`.
///
/// Exactly one of the three shapes is valid for a tunnel, and the shape must
/// match its `type`; the tunnel service enforces that.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TunnelOptions {
    /// TCP / UDP: expose a remote port.
    Port {
        #[serde(rename = "remotePort")]
        remote_port: u16,
    },
    /// HTTP / HTTPS: expose one or more domains.
    Domain {
        #[serde(rename = "customDomains", default)]
        custom_domains: Vec<String>,
        #[serde(default)]
        subdomain: Option<String>,
        #[serde(default)]
        locations: Vec<String>,
    },
    /// STCP / XTCP: share a secret and a server name pair.
    Secret {
        #[serde(rename = "secretKey")]
        secret_key: String,
        role: SecretRole,
        #[serde(rename = "serverName", default)]
        server_name: Option<String>,
    },
}

/// A saved tunnel belonging to one profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub tunnel_type: TunnelType,
    #[serde(default)]
    pub enabled: bool,
    pub local_ip: String,
    pub local_port: u16,
    pub options: TunnelOptions,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// The editable half of a tunnel, as the create/update form sends it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInput {
    pub profile_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub tunnel_type: TunnelType,
    #[serde(default)]
    pub enabled: bool,
    pub local_ip: String,
    pub local_port: u16,
    pub options: TunnelOptions,
}

/// A tunnel plus the name of its profile, for the all-profiles table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelView {
    #[serde(flatten)]
    pub tunnel: Tunnel,
    pub profile_name: String,
}

/// A local `frpc` binary registered in the workspace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRecord {
    pub id: String,
    pub path: String,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub raw_version_output: String,
    pub added_at: i64,
    #[serde(default)]
    pub last_checked_at: Option<i64>,
}

/// A runtime record plus how many profiles reference it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    #[serde(flatten)]
    pub runtime: RuntimeRecord,
    pub profile_count: u32,
    pub in_use: bool,
}

/// Result of probing one path, before anything is persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProbe {
    pub path: String,
    pub valid: bool,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    #[serde(default)]
    pub raw_output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// One candidate found by the local discovery scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRuntime {
    pub path: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub architecture: Option<String>,
    /// Where the scan found it (`path`, `common`, `deep`).
    #[serde(default)]
    pub source: String,
    pub already_imported: bool,
    /// Set when `already_imported` points at a stored record.
    #[serde(default)]
    pub runtime_id: Option<String>,
}

/// Persisted UI preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrpPrefs {
    #[serde(default = "default_tab")]
    pub active_tab: String,
    #[serde(default = "default_log_retention_days")]
    pub log_retention_days: u32,
    #[serde(default = "default_log_max_file_size_mb")]
    pub log_max_file_size_mb: u32,
    #[serde(default = "default_log_max_files_per_profile")]
    pub log_max_files_per_profile: u32,
}

impl Default for FrpPrefs {
    fn default() -> Self {
        Self {
            active_tab: default_tab(),
            log_retention_days: default_log_retention_days(),
            log_max_file_size_mb: default_log_max_file_size_mb(),
            log_max_files_per_profile: default_log_max_files_per_profile(),
        }
    }
}

fn default_tab() -> String {
    "overview".to_string()
}

fn default_log_retention_days() -> u32 {
    7
}

fn default_log_max_file_size_mb() -> u32 {
    20
}

fn default_log_max_files_per_profile() -> u32 {
    5
}

/// The whole persisted state: `frp.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub profiles: Vec<FrpProfile>,
    #[serde(default)]
    pub tunnels: Vec<Tunnel>,
    #[serde(default)]
    pub runtimes: Vec<RuntimeRecord>,
    #[serde(default)]
    pub prefs: FrpPrefs,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: default_version(),
            profiles: Vec::new(),
            tunnels: Vec::new(),
            runtimes: Vec::new(),
            prefs: FrpPrefs::default(),
        }
    }
}

fn default_version() -> u32 {
    1
}

/// The lifecycle of one profile's `frpc` child process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProcessState {
    Starting,
    Running,
    Stopping,
    #[default]
    Stopped,
    Reconnecting,
    Failed,
}

/// The state inferred for one tunnel from the running process's log output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    #[default]
    Unknown,
    Online,
    Offline,
    Error,
}

/// One tunnel's inferred state, as carried by snapshots and metrics events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRuntimeState {
    pub name: String,
    pub state: TunnelState,
    #[serde(default)]
    pub message: Option<String>,
}

/// Everything the overview needs to describe one profile's connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub profile_id: String,
    pub state: ProcessState,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub runtime_version: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub tunnel_states: Vec<TunnelRuntimeState>,
    #[serde(default)]
    pub latency_ms: Option<u32>,
    #[serde(default)]
    pub config_revision: i64,
}

/// What `frp_profiles_list` returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrpProfilesView {
    pub profiles: Vec<FrpProfile>,
    pub prefs: FrpPrefs,
    pub log_dir: String,
}

/// One profile a batch action could not complete.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    pub profile_id: String,
    pub error: FrpError,
}

/// What the start-all / stop-all commands return.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub succeeded: Vec<String>,
    pub failed: Vec<BatchFailure>,
}

/// The redacted TOML preview for one profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPreview {
    pub profile_id: String,
    pub content: String,
    pub redacted: bool,
    pub tunnel_count: u32,
}

/// What `frp_config_verify` returns after running `frpc verify`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigVerifyResult {
    pub valid: bool,
    pub message: String,
    pub raw_output: String,
    pub config_path: String,
    pub sha256: String,
}

/// Where an import reads its `frpc.toml` from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConfigImportSource {
    /// The caller already holds the text.
    Text { content: String },
    /// A file on disk, read by the engine so no filesystem plugin is needed.
    File { path: String },
}

/// One proxy an import would create, shaped like the tunnel form's data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTunnelPreview {
    pub name: String,
    #[serde(rename = "type")]
    pub tunnel_type: TunnelType,
    pub enabled: bool,
    pub local_ip: String,
    pub local_port: u16,
    pub options: TunnelOptions,
}

/// What `frp_config_import_preview` returns; nothing has been written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportPreview {
    pub server_addr: String,
    pub server_port: u16,
    pub token_present: bool,
    pub tunnels: Vec<ImportTunnelPreview>,
    /// Proxies that were skipped, and anything else the user should review.
    pub warnings: Vec<String>,
}

/// What `frp_config_import` returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportResult {
    pub profile: FrpProfile,
    pub tunnel_count: u32,
    pub warnings: Vec<String>,
    pub token_applied: bool,
}

/// Which stream a log line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// Level inferred for one log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// One log line, as pushed by `frp:log` and returned by `frp_logs_recent`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub profile_id: String,
    pub stream: LogStream,
    pub level: LogLevel,
    pub message: String,
    /// Unix milliseconds.
    pub timestamp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tunnel_options_round_trip_in_all_three_shapes() {
        let port = TunnelOptions::Port { remote_port: 6000 };
        let domain = TunnelOptions::Domain {
            custom_domains: vec!["app.example.com".to_string()],
            subdomain: Some("demo".to_string()),
            locations: vec!["/api".to_string()],
        };
        let secret = TunnelOptions::Secret {
            secret_key: "shared-key".to_string(),
            role: SecretRole::Visitor,
            server_name: Some("ssh".to_string()),
        };

        for options in [port, domain, secret] {
            let text = serde_json::to_string(&options).expect("serialize");
            let back: TunnelOptions = serde_json::from_str(&text).expect("deserialize");
            assert_eq!(back, options);
        }

        let tagged = serde_json::to_value(TunnelOptions::Port { remote_port: 1 }).expect("value");
        assert_eq!(tagged, json!({ "kind": "port", "remotePort": 1 }));
    }

    #[test]
    fn tunnel_options_default_the_optional_domain_fields() {
        let options: TunnelOptions =
            serde_json::from_value(json!({ "kind": "domain", "customDomains": ["a.example.com"] }))
                .expect("deserialize");
        assert_eq!(
            options,
            TunnelOptions::Domain {
                custom_domains: vec!["a.example.com".to_string()],
                subdomain: None,
                locations: Vec::new(),
            }
        );
    }

    #[test]
    fn a_profile_tolerates_missing_optional_fields() {
        let profile: FrpProfile = serde_json::from_value(json!({
            "id": "p1",
            "name": "Home",
            "serverAddr": "frps.example.com",
            "serverPort": 7000,
            "createdAt": 1
        }))
        .expect("deserialize");

        assert_eq!(profile.token, None);
        assert_eq!(profile.runtime_policy, RuntimePolicy::Recommended);
        assert_eq!(profile.runtime_id, None);
        assert!(!profile.reconnect_enabled);
        assert_eq!(profile.config_revision, 0);
        assert_eq!(profile.sort_order, 0);
        assert_eq!(profile.updated_at, 0);
    }
}
