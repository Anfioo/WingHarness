// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Data transfer objects shared by the engine, the Tauri commands and the
//! front-end `types.ts`. Field names are part of the frozen contract: adding,
//! renaming or dropping one breaks the TypeScript mirror.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Http,
    Media,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Connecting,
    Downloading,
    Paused,
    Moving,
    Completed,
    Failed,
    Canceled,
}

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Canceled)
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Connecting | Self::Downloading | Self::Moving)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Connecting => "connecting",
            Self::Downloading => "downloading",
            Self::Paused => "paused",
            Self::Moving => "moving",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "queued" => Self::Queued,
            "connecting" => Self::Connecting,
            "downloading" => Self::Downloading,
            "paused" => Self::Paused,
            "moving" => Self::Moving,
            "completed" => Self::Completed,
            // Stalled was folded into Failed; an old row is read as a failure.
            "stalled" => Self::Failed,
            "canceled" => Self::Canceled,
            _ => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub kind: TaskKind,
    pub url: String,
    pub filename: String,
    pub dest: String,
    pub status: TaskStatus,
    pub total: Option<u64>,
    pub received: u64,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub active_ms: i64,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub final_dir: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

impl Task {
    pub fn part_path(&self) -> String {
        format!("{}.part", self.dest)
    }

    pub fn meta_path(&self) -> String {
        format!("{}.part.meta", self.dest)
    }
}

/// One connection's byte range and how far it has written.
///
/// `position` is the next byte to write, so `position - start` is the segment's
/// progress. A completed segment has `position == end + 1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentProgress {
    pub start: u64,
    pub end: u64,
    pub position: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskProgress {
    pub id: String,
    pub received: u64,
    pub total: Option<u64>,
    pub speed: u64,
    pub status: TaskStatus,
    /// Empty for a single-stream transfer and for backends that cannot report
    /// per-connection ranges.
    #[serde(default)]
    pub segments: Vec<SegmentProgress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub max_concurrent: usize,
    pub connections: usize,
    pub min_split_size: u64,
    pub hide_part_files: bool,
    pub stall_timeout_secs: u64,
    pub connect_timeout_secs: u64,
    pub download_dir: Option<String>,
    /// Backend id used for direct HTTP downloads. It names a *preferred* engine:
    /// when that engine is missing or cannot handle the task, the queue falls
    /// back to the first usable backend instead of failing.
    pub http_backend: String,
    pub aria2_path: Option<String>,
    pub rpc_enabled: bool,
    pub rpc_port: u16,
    pub rpc_token: String,
    pub notify_on_complete: bool,
    pub add_paused: bool,
    pub progress_flush_ms: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_concurrent: 4,
            connections: 8,
            min_split_size: 1 << 20,
            hide_part_files: false,
            stall_timeout_secs: 60,
            connect_timeout_secs: 30,
            download_dir: None,
            http_backend: "embedded".to_string(),
            aria2_path: None,
            rpc_enabled: true,
            rpc_port: 47653,
            rpc_token: String::new(),
            notify_on_complete: true,
            add_paused: false,
            progress_flush_ms: 250,
        }
    }
}

impl Settings {
    /// The flush interval is clamped on read, not on write, so a hand-edited
    /// `settings.json` can still be corrected instead of silently rewritten.
    pub fn progress_flush_interval(&self) -> Duration {
        Duration::from_millis(self.progress_flush_ms.clamp(100, 5_000))
    }

    pub(crate) fn validate(&mut self) -> Result<(), String> {
        if self.max_concurrent > 64 {
            return Err("max_concurrent must be between 0 and 64".to_string());
        }
        if !(1..=64).contains(&self.connections) {
            return Err("connections must be between 1 and 64".to_string());
        }
        if !(1..=65_535).contains(&self.rpc_port) {
            return Err("rpc_port must be between 1 and 65535".to_string());
        }
        if !matches!(self.http_backend.as_str(), "embedded" | "aria2") {
            return Err("http_backend must be embedded or aria2".to_string());
        }
        self.progress_flush_ms = self.progress_flush_ms.clamp(100, 5_000);
        Ok(())
    }
}

/// How a download entered the queue. moin also knew `manual-torrent`,
/// `watch-folder` and `watch-url-file`; the BitTorrent port is out of scope, so
/// those fold into the two surviving methods instead of failing to parse. That
/// keeps a hand-copied `categories.json` loadable without a migration step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AddMethodKind {
    #[serde(alias = "manual-torrent")]
    ManualLink,
    #[serde(alias = "watch-folder", alias = "watch-url-file")]
    BrowserCapture,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Trigger {
    Extension { exts: Vec<String> },
    Size { min: Option<u64>, max: Option<u64> },
    UrlPattern { patterns: Vec<String> },
    NamePattern { patterns: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub hidden_from_all: bool,
    #[serde(default)]
    pub save_dir: Option<String>,
    #[serde(default)]
    pub incomplete_dir: Option<String>,
    #[serde(default)]
    pub sources: Vec<AddMethodKind>,
    #[serde(default)]
    pub triggers: Vec<Trigger>,
    #[serde(default)]
    pub order: i32,
    /// Everything a future BitTorrent port would need; kept opaque so
    /// `categories.json` round-trips without a later migration.
    #[serde(flatten, default)]
    pub legacy: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolSource {
    Override,
    Env,
    Path,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolStatus {
    pub id: String,
    pub present: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<ToolSource>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendInfo {
    pub id: String,
    pub label: String,
    pub http: bool,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcStatus {
    pub enabled: bool,
    pub port: u16,
    pub bound: bool,
    pub address: Option<String>,
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Strip the path, the reserved Windows characters and the trailing dots a
/// filesystem would reject. `None` means "nothing usable is left".
pub fn sanitize_filename(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|ch| {
            !ch.is_control() && !matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn filename_from_url(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .filter(|segment| !segment.trim().is_empty())
        .unwrap_or("download")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{filename_from_url, sanitize_filename, Settings, TaskStatus};

    #[test]
    fn sanitizes_windows_paths_and_invalid_characters() {
        assert_eq!(sanitize_filename("C:\\tmp\\a<b>.zip").as_deref(), Some("ab.zip"));
        assert_eq!(sanitize_filename("...."), None);
        assert_eq!(sanitize_filename("  report.pdf.  ").as_deref(), Some("report.pdf"));
    }

    #[test]
    fn extracts_file_name_from_url() {
        assert_eq!(filename_from_url("https://example.test/a/file.zip?x=1"), "file.zip");
        assert_eq!(filename_from_url("https://example.test/"), "example.test");
        assert_eq!(filename_from_url("https://example.test"), "example.test");
    }

    #[test]
    fn clamps_progress_interval() {
        let settings = Settings { progress_flush_ms: 1, ..Default::default() };
        assert_eq!(settings.progress_flush_interval().as_millis(), 100);
        let settings = Settings { progress_flush_ms: 5_001, ..Default::default() };
        assert_eq!(settings.progress_flush_interval().as_millis(), 5_000);
    }

    #[test]
    fn terminal_and_active_statuses_are_disjoint() {
        assert!(TaskStatus::Completed.is_terminal());
        assert!(!TaskStatus::Completed.is_active());
        assert!(TaskStatus::Downloading.is_active());
        assert!(!TaskStatus::Paused.is_terminal());
        assert!(!TaskStatus::Paused.is_active());
    }
}
