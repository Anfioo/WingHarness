//! The process table entry, the launch contract and the frozen timing
//! constants shared by the exit and health watchers.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Child;
use std::time::{Duration, Instant};

use crate::models::{ConnectionSnapshot, ProcessState, TunnelRuntimeState};

/// How long `stop` waits for a killed child before giving up on it.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the health loop probes the server while the grace window is open.
pub const LATENCY_INTERVAL: Duration = Duration::from_secs(2);
/// Minimum spacing between two health probes once the grace window has passed.
pub const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(15);
/// How long a fresh process may run before health probes can restart it.
pub const HEALTH_GRACE: Duration = Duration::from_secs(45);
/// Pause before re-probing after a wake-up, to let the network settle.
pub const WAKE_CONFIRM_DELAY: Duration = Duration::from_secs(2);
/// Rapid crashes in a row that trip the reconnect circuit breaker.
pub const MAX_CONSECUTIVE_CRASHES: u32 = 5;
/// A process that lived this long resets the crash counter on exit.
pub const STABLE_RUNTIME: Duration = Duration::from_secs(30);
/// Exits faster than this count as crashes.
pub const CRASH_WINDOW: Duration = Duration::from_secs(15);
/// Upper bound of the reconnect backoff.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Ring buffer size per profile.
pub const MAX_LOG_LINES: usize = 400;

/// Everything `ProcessRegistry::start` needs; prepared by the command layer so
/// the registry never has to look at the workspace.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub profile_id: String,
    pub runtime_id: String,
    pub runtime_version: String,
    pub runtime_path: PathBuf,
    pub config_path: PathBuf,
    pub work_dir: PathBuf,
    pub reconnect_enabled: bool,
    /// `serverAddr:serverPort` of the frps control port, used by health probes.
    pub server_endpoint: String,
    /// Revision of the generated config this launch runs; carried into every
    /// snapshot so the UI can flag "restart to apply".
    pub config_revision: i64,
}

/// A state in which a process is already being supervised and cannot be
/// replaced by a second `start`.
pub(crate) fn is_active(state: ProcessState) -> bool {
    matches!(
        state,
        ProcessState::Starting | ProcessState::Running | ProcessState::Reconnecting | ProcessState::Stopping
    )
}

/// Generation a real spawn registers under.
///
/// A `Starting` placeholder keeps the generation it reserved, so the watchers
/// started for it stay valid; every other spawn takes a fresh value. Values come
/// from one monotonic counter, so a watcher can never mistake a later process
/// for its own even after the table entry was dropped.
pub(crate) fn resolve_spawn_generation(
    existing: Option<(ProcessState, u64, bool)>,
    fresh: u64,
) -> u64 {
    match existing {
        Some((ProcessState::Starting, generation, false)) => generation,
        _ => fresh,
    }
}

pub(crate) struct ManagedProcess {
    pub profile_id: String,
    pub launch: LaunchSpec,
    pub child: Option<Child>,
    pub state: ProcessState,
    /// Bumped on every real spawn so stale watchers exit.
    pub generation: u64,
    pub started_at: Instant,
    pub started_at_epoch: i64,
    pub last_error: Option<String>,
    pub reconnect_attempt: u32,
    pub consecutive_crashes: u32,
    /// Set when a log line proves retrying is pointless.
    pub permanent_failure: bool,
    pub cancel_reconnect: bool,
    pub tunnel_states: BTreeMap<String, TunnelRuntimeState>,
    pub health_failures: u32,
    pub latency_ms: Option<u32>,
    pub force_health: bool,
}

/// What the exit watcher hands to the reconnect path once the child is gone.
pub(crate) struct ReconnectDecision {
    pub launch: LaunchSpec,
    pub reconnect_attempt: u32,
    pub consecutive_crashes: u32,
    pub delay: Duration,
    pub snapshot: ConnectionSnapshot,
    pub exit_message: String,
}

impl ManagedProcess {
    /// Kill the live child without taking the handle, so the exit watcher can
    /// observe the status and run the normal reconnect path.
    pub(crate) fn kill_child_in_place(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        let _ = child.kill();
        true
    }

    pub(crate) fn placeholder(
        profile_id: impl Into<String>,
        launch: LaunchSpec,
        generation: u64,
        state: ProcessState,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            launch,
            child: None,
            state,
            generation,
            started_at: Instant::now(),
            started_at_epoch: crate::process::now_epoch_seconds(),
            last_error: None,
            reconnect_attempt: 0,
            consecutive_crashes: 0,
            permanent_failure: false,
            cancel_reconnect: false,
            tunnel_states: BTreeMap::new(),
            health_failures: 0,
            latency_ms: None,
            force_health: false,
        }
    }

    pub(crate) fn to_snapshot(&self) -> ConnectionSnapshot {
        ConnectionSnapshot {
            profile_id: self.profile_id.clone(),
            state: self.state,
            pid: self.child.as_ref().map(Child::id),
            runtime_id: Some(self.launch.runtime_id.clone()),
            runtime_version: Some(self.launch.runtime_version.clone()),
            started_at: Some(self.started_at_epoch),
            last_error: self.last_error.clone(),
            tunnel_states: self.tunnel_states.values().cloned().collect(),
            latency_ms: self.latency_ms,
            config_revision: self.launch.config_revision,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> LaunchSpec {
        LaunchSpec {
            profile_id: "p1".into(),
            runtime_id: "rt".into(),
            runtime_version: "0.61.0".into(),
            runtime_path: PathBuf::from("frpc"),
            config_path: PathBuf::from("frpc.toml"),
            work_dir: PathBuf::from("."),
            reconnect_enabled: true,
            server_endpoint: "127.0.0.1:7000".into(),
            config_revision: 3,
        }
    }

    #[test]
    fn spawn_keeps_starting_reservation_generation() {
        assert_eq!(
            resolve_spawn_generation(Some((ProcessState::Starting, 3, false)), 9),
            3
        );
    }

    #[test]
    fn spawn_takes_a_fresh_generation_otherwise() {
        assert_eq!(
            resolve_spawn_generation(Some((ProcessState::Reconnecting, 3, false)), 9),
            9
        );
        assert_eq!(
            resolve_spawn_generation(Some((ProcessState::Running, 3, true)), 9),
            9
        );
        assert_eq!(
            resolve_spawn_generation(Some((ProcessState::Starting, 3, true)), 9),
            9,
            "a starting state that already owns a child is not a reservation"
        );
    }

    #[test]
    fn spawn_defaults_when_empty() {
        assert_eq!(resolve_spawn_generation(None, 1), 1);
    }

    #[test]
    fn placeholder_is_active_and_carries_the_config_revision() {
        let process = ManagedProcess::placeholder("p1", launch(), 2, ProcessState::Starting);
        let snapshot = process.to_snapshot();
        assert!(is_active(snapshot.state));
        assert_eq!(snapshot.pid, None);
        assert_eq!(snapshot.config_revision, 3);
        assert_eq!(snapshot.runtime_version.as_deref(), Some("0.61.0"));
    }

    #[test]
    fn active_states_are_exactly_the_supervised_ones() {
        assert!(is_active(ProcessState::Starting));
        assert!(is_active(ProcessState::Running));
        assert!(is_active(ProcessState::Reconnecting));
        assert!(is_active(ProcessState::Stopping));
        assert!(!is_active(ProcessState::Stopped));
        assert!(!is_active(ProcessState::Failed));
    }
}
