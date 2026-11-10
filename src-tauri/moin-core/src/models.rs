// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See UPSTREAM.md for the porting record.

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
    Stalled,
    Canceled,
}

impl TaskStatus {
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
            Self::Stalled => "stalled",
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
            "stalled" => Self::Stalled,
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
    pub archived: bool,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskProgress {
    pub id: String,
    pub received: u64,
    pub total: Option<u64>,
    pub speed: u64,
    pub status: TaskStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MoinSettings {
    pub max_concurrent: usize,
    pub connections: usize,
    pub min_split_size: u64,
    pub hide_part_files: bool,
    pub stall_timeout_secs: u64,
    pub connect_timeout_secs: u64,
    pub download_dir: Option<String>,
    pub proxy_url: Option<String>,
    pub aria2_path: Option<String>,
    pub rpc_enabled: bool,
    pub rpc_port: u16,
    pub rpc_token: String,
    pub notify_on_complete: bool,
    pub add_paused: bool,
    pub progress_flush_ms: u64,
    pub http_backend: String,
}

impl Default for MoinSettings {
    fn default() -> Self {
        Self {
            max_concurrent: 4,
            connections: 8,
            min_split_size: 1 << 20,
            hide_part_files: false,
            stall_timeout_secs: 60,
            connect_timeout_secs: 30,
            download_dir: None,
            proxy_url: None,
            aria2_path: None,
            rpc_enabled: true,
            rpc_port: 47653,
            rpc_token: String::new(),
            notify_on_complete: true,
            add_paused: false,
            progress_flush_ms: 250,
            http_backend: "embedded".to_string(),
        }
    }
}

impl MoinSettings {
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
        if self.http_backend != "embedded" && self.http_backend != "aria2" {
            return Err("http_backend must be embedded or aria2".to_string());
        }
        self.progress_flush_ms = self.progress_flush_ms.clamp(100, 5_000);
        Ok(())
    }
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

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
    use super::{filename_from_url, sanitize_filename, MoinSettings};

    #[test]
    fn sanitizes_windows_paths_and_invalid_characters() {
        assert_eq!(sanitize_filename("C:\\tmp\\a<b>.zip").as_deref(), Some("ab.zip"));
        assert_eq!(sanitize_filename("...."), None);
    }

    #[test]
    fn extracts_file_name_from_url() {
        assert_eq!(filename_from_url("https://example.test/a/file.zip?x=1"), "file.zip");
        assert_eq!(filename_from_url("https://example.test/"), "example.test");
    }

    #[test]
    fn clamps_progress_interval() {
        let settings = MoinSettings { progress_flush_ms: 1, ..Default::default() };
        assert_eq!(settings.progress_flush_interval().as_millis(), 100);
    }
}
