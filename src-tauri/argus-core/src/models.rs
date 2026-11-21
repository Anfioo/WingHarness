//! Public data-transfer objects shared by the host commands and the frontend.

use serde::{Deserialize, Serialize};

/// Fastest sampling interval the page accepts, in milliseconds.
pub const MIN_INTERVAL_MS: u64 = 250;
/// Slowest sampling interval the page accepts, in milliseconds.
pub const MAX_INTERVAL_MS: u64 = 5000;
/// The interval a fresh install starts with.
pub const DEFAULT_INTERVAL_MS: u64 = 1000;

/// Fastest background sampling interval, in milliseconds.
pub const MIN_BACKGROUND_INTERVAL_MS: u64 = 1_000;
/// Slowest background sampling interval, in milliseconds.
pub const MAX_BACKGROUND_INTERVAL_MS: u64 = 60_000;
/// The background interval a fresh install starts with.
pub const DEFAULT_BACKGROUND_INTERVAL_MS: u64 = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ArgusSettings {
    pub interval_ms: u64,
    pub background_monitoring: bool,
    pub background_interval_ms: u64,
}

impl Default for ArgusSettings {
    fn default() -> Self {
        Self {
            interval_ms: DEFAULT_INTERVAL_MS,
            background_monitoring: false,
            background_interval_ms: DEFAULT_BACKGROUND_INTERVAL_MS,
        }
    }
}

impl ArgusSettings {
    /// A settings value that only changes the foreground interval. Callers that
    /// already hold the current settings must edit the field instead, so the
    /// background fields survive.
    pub fn with_interval_ms(interval_ms: u64) -> Self {
        Self {
            interval_ms,
            ..Self::default()
        }
        .clamped()
    }

    /// Keep both intervals inside the ranges the sampler can honour.
    pub fn clamped(self) -> Self {
        Self {
            interval_ms: self.interval_ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS),
            background_monitoring: self.background_monitoring,
            background_interval_ms: self
                .background_interval_ms
                .clamp(MIN_BACKGROUND_INTERVAL_MS, MAX_BACKGROUND_INTERVAL_MS),
        }
    }
}

/// One program that starts at logon.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    /// `<location>|<entry>`; pass back to `startup::set_enabled`.
    pub id: String,
    pub name: String,
    /// Original registry value, shortcut name or packaged task identifier.
    pub entry: String,
    pub command: String,
    /// Executable the command runs, when it could be resolved.
    pub path: Option<String>,
    /// `hkcuRun`, `hklmRun`, `hklmRun32`, `userFolder`, `commonFolder` or
    /// `package`.
    pub location: &'static str,
    /// Applies to all users (needs administrator rights to change).
    pub machine: bool,
    pub enabled: bool,
    /// `managed` or `unavailable`; None when the switch can be changed.
    pub blocked: Option<&'static str>,
    /// False when the target executable no longer exists.
    pub exists: bool,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub icon: Option<u32>,
}

/// One TCP or UDP endpoint with its owning process.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// `tcp` or `udp`.
    pub protocol: &'static str,
    pub ipv6: bool,
    pub local_address: String,
    pub local_port: u16,
    /// None for listening TCP sockets and for UDP.
    pub remote_address: Option<String>,
    pub remote_port: Option<u16>,
    /// TCP only: `listen` | `established` | `synSent` | `synReceived` |
    /// `finWait1` | `finWait2` | `closeWait` | `closing` | `lastAck` |
    /// `timeWait` | `closed`.
    pub state: Option<&'static str>,
    pub pid: u32,
}

/// System totals for one history frame (or one chart bucket).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    /// Unix ms: the frame's start, or a bucket's average.
    pub ts: i64,
    /// Average CPU, percent.
    pub cpu: f32,
    /// Highest CPU sample in the frame (or bucket).
    pub cpu_peak: f32,
    /// Busiest GPU engine, percent.
    pub gpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    /// Bytes per second, all disks.
    pub disk: u64,
    /// Bytes per second, all adapters.
    pub net: u64,
    /// Battery charge, percent, averaged over the frame.
    pub battery: Option<f32>,
    /// Battery power flow, mW, averaged over the frame.
    pub battery_rate: Option<f32>,
}

/// A process that stood out in one history frame.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryProcess {
    pub name: String,
    pub pid: u32,
    /// Averages over the frame.
    pub cpu: f32,
    pub mem: u64,
    pub io: u64,
    pub gpu: f32,
    pub net: u64,
}

/// What the recorded history takes on disk.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryUsage {
    /// Size of all day files.
    pub bytes: u64,
    /// Unix ms of the oldest recorded frame.
    pub first: Option<i64>,
}

/// One frame: the system and the processes that stood out at that moment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMoment {
    pub system: HistoryPoint,
    pub processes: Vec<HistoryProcess>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_one_second_with_background_off() {
        let settings = ArgusSettings::default();
        assert_eq!(settings.interval_ms, 1000);
        assert!(!settings.background_monitoring);
        assert_eq!(settings.background_interval_ms, 5_000);
    }

    #[test]
    fn interval_is_clamped_to_the_supported_range() {
        assert_eq!(
            ArgusSettings::with_interval_ms(0).interval_ms,
            MIN_INTERVAL_MS
        );
        assert_eq!(
            ArgusSettings::with_interval_ms(60_000).interval_ms,
            MAX_INTERVAL_MS
        );
        assert_eq!(ArgusSettings::with_interval_ms(1500).interval_ms, 1500);
    }

    #[test]
    fn background_interval_is_clamped_to_the_supported_range() {
        let low = ArgusSettings {
            background_interval_ms: 0,
            ..ArgusSettings::default()
        }
        .clamped();
        assert_eq!(low.background_interval_ms, MIN_BACKGROUND_INTERVAL_MS);
        let high = ArgusSettings {
            background_interval_ms: u64::MAX,
            ..ArgusSettings::default()
        }
        .clamped();
        assert_eq!(high.background_interval_ms, MAX_BACKGROUND_INTERVAL_MS);
        let background = ArgusSettings {
            background_monitoring: true,
            ..ArgusSettings::default()
        }
        .clamped();
        assert!(background.background_monitoring);
    }
}
