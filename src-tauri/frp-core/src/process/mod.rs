//! `ProcessRegistry` — the process table, the log ring buffers and the log
//! preferences, with no knowledge of workspaces or profiles as stored data.
//!
//! The command layer resolves a profile into a [`LaunchSpec`]; from there this
//! module owns the child, its watchers and its logs. Nothing here is ever
//! persisted: state lives in memory and the pid record on disk only exists so a
//! crashed session can be reaped on the next start.

mod lifecycle;
mod logs;
mod policy;
pub mod types;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Instant;

use crate::error::FrpResult;
use crate::models::{
    BatchFailure, BatchResult, ConnectionSnapshot, FrpPrefs, LogEntry, ProcessState,
};

use lifecycle::STOP_WAIT_STEP;
use types::{is_active, ManagedProcess, STOP_TIMEOUT};

pub use types::{LaunchSpec, MAX_LOG_LINES};

/// Lock a registry mutex, recovering the guard if a previous holder panicked.
pub(crate) fn lock_guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn now_epoch_seconds() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(crate) fn now_epoch_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The snapshot every command returns when a profile has no live process.
pub(crate) fn stopped_snapshot(profile_id: &str) -> ConnectionSnapshot {
    ConnectionSnapshot {
        profile_id: profile_id.to_string(),
        state: ProcessState::Stopped,
        pid: None,
        runtime_id: None,
        runtime_version: None,
        started_at: None,
        last_error: None,
        tunnel_states: Vec::new(),
        latency_ms: None,
        config_revision: 0,
    }
}

pub struct ProcessRegistry {
    pub(crate) app: tauri::AppHandle,
    pub(crate) processes: Mutex<HashMap<String, ManagedProcess>>,
    pub(crate) logs: Mutex<HashMap<String, VecDeque<LogEntry>>>,
    pub(crate) log_prefs: Mutex<FrpPrefs>,
    /// One counter for every spawn, so a generation stays unique even after its
    /// table entry has been dropped.
    generations: AtomicU64,
    shutdown_flag: AtomicBool,
}

impl ProcessRegistry {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            processes: Mutex::new(HashMap::new()),
            logs: Mutex::new(HashMap::new()),
            log_prefs: Mutex::new(FrpPrefs::default()),
            generations: AtomicU64::new(0),
            shutdown_flag: AtomicBool::new(false),
        }
    }

    fn next_generation(&self) -> u64 {
        self.generations.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Persisted rotations apply to the next line written; the command layer
    /// hands in the workspace preferences before every start.
    pub fn set_log_prefs(&self, prefs: FrpPrefs) {
        *lock_guard(&self.log_prefs) = prefs;
    }

    pub(crate) fn log_prefs(&self) -> FrpPrefs {
        lock_guard(&self.log_prefs).clone()
    }

    pub fn snapshot(&self, profile_id: &str) -> ConnectionSnapshot {
        let guard = lock_guard(&self.processes);
        match guard.get(profile_id) {
            Some(process) => process.to_snapshot(),
            None => stopped_snapshot(profile_id),
        }
    }

    pub fn snapshots(&self) -> Vec<ConnectionSnapshot> {
        let guard = lock_guard(&self.processes);
        let mut snapshots: Vec<ConnectionSnapshot> = guard
            .values()
            .map(ManagedProcess::to_snapshot)
            .collect();
        snapshots.sort_by(|left, right| left.profile_id.cmp(&right.profile_id));
        snapshots
    }

    /// Start a process, or return the running one.
    ///
    /// A `Starting` placeholder is inserted before the child is spawned, so a
    /// second concurrent `start` sees an active entry and returns instead of
    /// spawning a second `frpc`.
    pub fn start(self: &Arc<Self>, launch: LaunchSpec) -> FrpResult<ConnectionSnapshot> {
        let profile_id = launch.profile_id.clone();

        let (reservation_generation, starting) = {
            let mut guard = lock_guard(&self.processes);
            if let Some(existing) = guard.get(&profile_id) {
                if is_active(existing.state) {
                    return Ok(existing.to_snapshot());
                }
            }
            let generation = self.next_generation();
            if let Some(existing) = guard.get_mut(&profile_id) {
                existing.cancel_reconnect = true;
            }
            let placeholder = ManagedProcess::placeholder(
                profile_id.clone(),
                launch.clone(),
                generation,
                ProcessState::Starting,
            );
            let snapshot = placeholder.to_snapshot();
            guard.insert(profile_id.clone(), placeholder);
            (generation, snapshot)
        };
        crate::events::emit_state(&self.app, &starting);

        match self.spawn_process(launch, 0, 0) {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                let mut guard = lock_guard(&self.processes);
                if let Some(process) = guard.get(&profile_id) {
                    if process.generation == reservation_generation
                        && process.child.is_none()
                        && process.state == ProcessState::Starting
                    {
                        guard.remove(&profile_id);
                    }
                }
                Err(error)
            }
        }
    }

    /// Stop the profile's process: mark it stopping, cancel any pending
    /// reconnect, kill the child, wait at most `STOP_TIMEOUT`, then drop the pid
    /// record and the table entry.
    pub fn stop(&self, profile_id: &str) -> FrpResult<ConnectionSnapshot> {
        let (child, stopping) = {
            let mut guard = lock_guard(&self.processes);
            let Some(process) = guard.get_mut(profile_id) else {
                return Ok(stopped_snapshot(profile_id));
            };
            process.cancel_reconnect = true;
            process.state = ProcessState::Stopping;
            let snapshot = process.to_snapshot();
            (process.child.take(), snapshot)
        };
        crate::events::emit_state(&self.app, &stopping);

        match child {
            Some(mut child) => {
                let _ = child.kill();
                let deadline = Instant::now() + STOP_TIMEOUT;
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() < deadline => thread::sleep(STOP_WAIT_STEP),
                        Ok(None) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                        Err(_) => {
                            let _ = child.kill();
                            break;
                        }
                    }
                }
            }
            None => {
                // Mid-reconnect: the handle is already gone, so reap whatever
                // pid the previous spawn recorded.
                crate::orphan::terminate_recorded_orphan(profile_id);
            }
        }

        crate::orphan::clear_pid_record(profile_id);
        lock_guard(&self.processes).remove(profile_id);

        let snapshot = stopped_snapshot(profile_id);
        crate::events::emit_state(&self.app, &snapshot);
        self.push_system_log(
            &self.app,
            profile_id,
            crate::models::LogLevel::Info,
            "frpc stopped by user".to_string(),
        );
        Ok(snapshot)
    }

    pub fn restart(self: &Arc<Self>, launch: LaunchSpec) -> FrpResult<ConnectionSnapshot> {
        let profile_id = launch.profile_id.clone();
        self.stop(&profile_id)?;
        self.start(launch)
    }

    pub fn start_all(self: &Arc<Self>, launches: Vec<LaunchSpec>) -> FrpResult<BatchResult> {
        let mut result = BatchResult {
            succeeded: Vec::new(),
            failed: Vec::new(),
        };
        for launch in launches {
            let profile_id = launch.profile_id.clone();
            match self.start(launch) {
                Ok(_) => result.succeeded.push(profile_id),
                Err(error) => result.failed.push(BatchFailure { profile_id, error }),
            }
        }
        Ok(result)
    }

    pub fn stop_all(&self) -> FrpResult<BatchResult> {
        let ids: Vec<String> = lock_guard(&self.processes).keys().cloned().collect();
        let mut result = BatchResult {
            succeeded: Vec::new(),
            failed: Vec::new(),
        };
        for profile_id in ids {
            match self.stop(&profile_id) {
                Ok(_) => result.succeeded.push(profile_id),
                Err(error) => result.failed.push(BatchFailure { profile_id, error }),
            }
        }
        Ok(result)
    }

    /// Ask every running health loop to probe on its next tick.
    pub fn nudge_health(&self) -> usize {
        let mut guard = lock_guard(&self.processes);
        let mut nudged = 0;
        for process in guard.values_mut() {
            if process.state == ProcessState::Running {
                process.force_health = true;
                nudged += 1;
            }
        }
        nudged
    }

    /// Recent lines of one profile, or of every profile merged by timestamp.
    pub fn recent_logs(&self, profile_id: Option<&str>, limit: usize) -> Vec<LogEntry> {
        let limit = limit.clamp(1, 1000);
        let guard = lock_guard(&self.logs);
        match profile_id {
            Some(profile_id) => guard
                .get(profile_id)
                .map(|buffer| tail_entries(buffer, limit))
                .unwrap_or_default(),
            None => {
                let mut merged: Vec<LogEntry> = guard
                    .values()
                    .flat_map(|buffer| buffer.iter().cloned())
                    .collect();
                merged.sort_by_key(|entry| entry.timestamp);
                let skip = merged.len().saturating_sub(limit);
                merged.split_off(skip)
            }
        }
    }

    /// Clear the in-memory buffers only; rolled log files stay on disk.
    pub fn clear_logs(&self, profile_id: Option<&str>) {
        let mut guard = lock_guard(&self.logs);
        match profile_id {
            Some(profile_id) => {
                guard.remove(profile_id);
            }
            None => guard.clear(),
        }
    }

    pub fn is_runtime_in_use(&self, runtime_id: &str) -> bool {
        let guard = lock_guard(&self.processes);
        guard.values().any(|process| {
            process.launch.runtime_id == runtime_id && is_active(process.state)
        })
    }

    /// Idempotent: called from `RunEvent::Exit` after the window is gone.
    pub fn shutdown(&self) {
        if self.shutdown_flag.swap(true, Ordering::SeqCst) {
            return;
        }
        let ids: Vec<String> = lock_guard(&self.processes).keys().cloned().collect();
        for profile_id in ids {
            if let Err(error) = self.stop(&profile_id) {
                log::warn!(
                    "frp_shutdown_stop_failed profile={profile_id} error={}",
                    error.message
                );
            }
        }
    }
}

fn tail_entries(buffer: &VecDeque<LogEntry>, limit: usize) -> Vec<LogEntry> {
    let skip = buffer.len().saturating_sub(limit);
    buffer.iter().skip(skip).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{LogLevel, LogStream};

    fn entry(profile_id: &str, timestamp: i64, message: &str) -> LogEntry {
        LogEntry {
            profile_id: profile_id.to_string(),
            stream: LogStream::Stdout,
            level: LogLevel::Info,
            message: message.to_string(),
            timestamp,
        }
    }

    #[test]
    fn tail_keeps_the_newest_lines_in_order() {
        let mut buffer = VecDeque::new();
        for index in 0..10 {
            buffer.push_back(entry("p1", index, &format!("line {index}")));
        }
        let tail = tail_entries(&buffer, 3);
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0].message, "line 7");
        assert_eq!(tail[2].message, "line 9");

        let all = tail_entries(&buffer, 50);
        assert_eq!(all.len(), 10);
    }

    #[test]
    fn stopped_snapshot_has_no_process_details() {
        let snapshot = stopped_snapshot("p1");
        assert_eq!(snapshot.state, ProcessState::Stopped);
        assert!(snapshot.pid.is_none());
        assert!(snapshot.tunnel_states.is_empty());
    }
}
