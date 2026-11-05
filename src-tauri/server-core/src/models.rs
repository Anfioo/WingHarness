use serde::{Deserialize, Serialize};

/// How a profile authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Password,
    PrivateKey,
}

/// Which secret a keychain entry holds. The value is the entry suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    Password,
    Passphrase,
}

impl SecretKind {
    pub fn entry_suffix(self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::Passphrase => "passphrase",
        }
    }
}

/// A saved server, as the frontend sees it.
///
/// Carries its credentials in plain text by explicit user request: `password`,
/// `passphrase` and `private_key` are persisted verbatim in `servers.json`, and
/// that file is not encrypted. The UI masks the password fields by default but
/// can reveal them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub private_key: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    pub terminal_type: String,
    pub note: String,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_connected_at: Option<i64>,
}

/// The editable half of a profile: what the create/update form sends.
///
/// The three credential fields travel in plain text, like they are stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfileInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub private_key: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    pub terminal_type: Option<String>,
    pub note: Option<String>,
    pub color: Option<String>,
}

/// Which of two entries' names win when a transfer would collide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Ask,
    Overwrite,
    Skip,
    Rename,
}

/// Persisted UI preferences shared by every window.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPrefs {
    pub local_pane_path: Option<String>,
    pub show_hidden_local: bool,
    pub show_hidden_remote: bool,
    pub conflict_policy: ConflictPolicy,
    pub max_concurrent_transfers: u32,
}

impl Default for ServerPrefs {
    fn default() -> Self {
        Self {
            local_pane_path: None,
            show_hidden_local: false,
            show_hidden_remote: false,
            conflict_policy: ConflictPolicy::Ask,
            max_concurrent_transfers: 3,
        }
    }
}

/// What `server_profiles_list` returns: both halves of `servers.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfilesView {
    pub profiles: Vec<ServerProfile>,
    pub prefs: ServerPrefs,
}

/// A trusted host key for one profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyRecord {
    pub fingerprint: String,
    pub algorithm: String,
    pub host: String,
    pub port: u16,
    pub trusted_at: i64,
}

/// Whether a directory entry is a file or a directory. Symlinks carry
/// `is_symlink` on top of the type they point at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

/// One row of a directory listing, local or remote.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    /// Absolute path; the panes keep it so a row can be acted on without
    /// re-joining the listing directory.
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// `rwxr-xr-x` style permissions, when the backend can provide them.
    pub permissions: Option<String>,
    /// Seconds since the Unix epoch.
    pub modified_at: Option<i64>,
    pub is_symlink: bool,
}

/// One interactive shell on an SSH connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub profile_id: String,
    pub cols: u16,
    pub rows: u16,
    pub started_at: i64,
}

/// The result of `server_connect`.
///
/// `reused` is true when the SSH connection already existed and only a new
/// shell channel was opened on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOutcome {
    pub session_id: String,
    pub connection_id: String,
    pub reused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Pending,
    Running,
    Paused,
    Done,
    Failed,
    Cancelled,
}

/// One transfer task, as the queue and the progress events see it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub transfer_id: String,
    pub profile_id: String,
    pub direction: TransferDirection,
    /// Absolute source path.
    pub source: String,
    /// Absolute destination path.
    pub target: String,
    pub transferred: u64,
    pub total: u64,
    pub bytes_per_sec: u64,
    pub state: TransferState,
    pub error: Option<String>,
}

/// CPU percentages of one sample. The first sample of a connection has no
/// previous counters to diff against, so every field is zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    pub overall: f64,
    pub user: f64,
    pub system: f64,
    pub iowait: f64,
    pub steal: f64,
}

/// Memory in bytes; `percent` is `used / total * 100`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub percent: f64,
}

/// Root filesystem usage and per-second I/O of the whole disks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetrics {
    pub total: u64,
    pub used: u64,
    pub percent: f64,
    pub inode_percent: f64,
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
}

/// Aggregate network throughput over every interface except loopback.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetrics {
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadMetrics {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

/// One metrics snapshot of a profile, taken once per second.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSample {
    /// Seconds since the Unix epoch.
    pub at: i64,
    /// Round-trip time of the metrics script, in milliseconds.
    pub latency_ms: f64,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub disk: DiskMetrics,
    pub network: NetworkMetrics,
    pub load: LoadMetrics,
    pub uptime_secs: u64,
    pub processes: u32,
    pub threads: u32,
}
