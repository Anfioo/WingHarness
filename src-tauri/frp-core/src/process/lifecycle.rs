//! Spawn, exit supervision, reconnect and health monitoring.
//!
//! Every loop here is keyed by the process generation it was started for: a
//! reconnect or a fresh `start` bumps the generation, so the previous watchers
//! notice the mismatch on their next tick and exit on their own.

use std::process::Stdio;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use tauri::AppHandle;

use crate::events::{self, MetricsEvent};
use crate::models::{ConnectionSnapshot, LogEntry, LogLevel, LogStream, ProcessState};
use crate::proc::hidden;

use super::logs::spawn_log_reader;
use super::policy::{
    is_permanent_failure_message, reconnect_delay, should_count_as_crash, tripped_circuit_breaker,
};
use super::types::{
    resolve_spawn_generation, LaunchSpec, ManagedProcess, ReconnectDecision, HEALTH_CHECK_INTERVAL,
    HEALTH_GRACE, LATENCY_INTERVAL, STABLE_RUNTIME, WAKE_CONFIRM_DELAY,
};
use super::{lock_guard, ProcessRegistry};

impl ProcessRegistry {
    /// Start the binary for `launch`, register it and hand it to the watchers.
    ///
    /// Called both from `start` (attempt 0) and from the reconnect path.
    pub(crate) fn spawn_process(
        self: &Arc<Self>,
        launch: LaunchSpec,
        reconnect_attempt: u32,
        consecutive_crashes: u32,
    ) -> crate::error::FrpResult<ConnectionSnapshot> {
        let profile_id = launch.profile_id.clone();

        let mut child = hidden(&launch.runtime_path)
            .arg("-c")
            .arg(&launch.config_path)
            .current_dir(&launch.work_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                log::warn!(
                    "frp_spawn_failed profile={profile_id} runtime={} error={error}",
                    launch.runtime_path.display()
                );
                crate::error::FrpError::spawn_failed(format!("failed to start frpc: {error}"))
            })?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let pid = child.id();
        let started_at_epoch = super::now_epoch_seconds();

        crate::orphan::write_pid_record(
            &profile_id,
            pid,
            &launch.config_path,
            &launch.runtime_path,
        );

        let generation = {
            let mut guard = lock_guard(&self.processes);
            let generation = resolve_spawn_generation(
                guard.get(&profile_id).map(|process| {
                    (process.state, process.generation, process.child.is_some())
                }),
                self.next_generation(),
            );
            guard.insert(
                profile_id.clone(),
                ManagedProcess {
                    profile_id: profile_id.clone(),
                    launch: launch.clone(),
                    child: Some(child),
                    state: ProcessState::Running,
                    generation,
                    started_at: Instant::now(),
                    started_at_epoch,
                    last_error: None,
                    reconnect_attempt,
                    consecutive_crashes,
                    permanent_failure: false,
                    cancel_reconnect: false,
                    tunnel_states: Default::default(),
                    health_failures: 0,
                    latency_ms: None,
                    force_health: false,
                },
            );
            generation
        };

        if let Some(stdout) = stdout {
            spawn_log_reader(
                Arc::clone(self),
                self.app.clone(),
                profile_id.clone(),
                LogStream::Stdout,
                stdout,
            );
        }
        if let Some(stderr) = stderr {
            spawn_log_reader(
                Arc::clone(self),
                self.app.clone(),
                profile_id.clone(),
                LogStream::Stderr,
                stderr,
            );
        }

        let exit_registry = Arc::clone(self);
        let health_registry = Arc::clone(self);
        let exit_app = self.app.clone();
        let health_app = self.app.clone();
        let exit_profile = profile_id.clone();
        let health_profile = profile_id.clone();
        thread::spawn(move || exit_registry.watch_exit(&exit_app, &exit_profile, generation));
        thread::spawn(move || health_registry.watch_health(&health_app, &health_profile, generation));

        let snapshot = ConnectionSnapshot {
            profile_id: profile_id.clone(),
            state: ProcessState::Running,
            pid: Some(pid),
            runtime_id: Some(launch.runtime_id.clone()),
            runtime_version: Some(launch.runtime_version.clone()),
            started_at: Some(started_at_epoch),
            last_error: None,
            tunnel_states: Vec::new(),
            latency_ms: None,
            config_revision: launch.config_revision,
        };
        events::emit_state(&self.app, &snapshot);

        self.push_log(
            &self.app,
            LogEntry {
                profile_id,
                stream: LogStream::Stdout,
                level: LogLevel::Info,
                message: if reconnect_attempt > 0 {
                    format!("frpc reconnected (pid {pid}, attempt {reconnect_attempt})")
                } else {
                    format!("frpc started (pid {pid})")
                },
                timestamp: super::now_epoch_millis(),
            },
        );

        Ok(snapshot)
    }

    /// Poll the child every 400ms and classify its exit.
    pub(crate) fn watch_exit(self: &Arc<Self>, app: &AppHandle, profile_id: &str, generation: u64) {
        loop {
            thread::sleep(Duration::from_millis(400));

            let exit_status = {
                let mut guard = lock_guard(&self.processes);
                let Some(process) = guard.get_mut(profile_id) else {
                    return;
                };
                if process.generation != generation {
                    return;
                }
                if matches!(
                    process.state,
                    ProcessState::Stopping | ProcessState::Stopped | ProcessState::Reconnecting
                ) {
                    return;
                }
                let Some(child) = process.child.as_mut() else {
                    return;
                };
                match child.try_wait() {
                    Ok(Some(status)) => Some(status),
                    Ok(None) => None,
                    Err(error) => {
                        let message = format!("failed to poll frpc: {error}");
                        process.state = ProcessState::Failed;
                        process.last_error = Some(message);
                        process.child = None;
                        let snapshot = process.to_snapshot();
                        drop(guard);
                        crate::orphan::clear_pid_record(profile_id);
                        events::emit_state(app, &snapshot);
                        return;
                    }
                }
            };

            let Some(status) = exit_status else {
                continue;
            };

            crate::orphan::clear_pid_record(profile_id);

            let decision = {
                let mut guard = lock_guard(&self.processes);
                let Some(process) = guard.get_mut(profile_id) else {
                    return;
                };
                if process.generation != generation {
                    return;
                }
                if process.state == ProcessState::Stopping || process.cancel_reconnect {
                    process.child = None;
                    return;
                }

                let lived = process.started_at.elapsed();
                let failed = !status.success();
                let exit_message = if failed {
                    format!("frpc exited unexpectedly with code {:?}", status.code())
                } else {
                    "frpc exited".to_string()
                };

                if process.permanent_failure || is_permanent_failure_message(&exit_message) {
                    process.child = None;
                    process.state = ProcessState::Failed;
                    process.last_error =
                        Some(process.last_error.clone().unwrap_or_else(|| exit_message.clone()));
                    let snapshot = process.to_snapshot();
                    drop(guard);
                    events::emit_state(app, &snapshot);
                    self.push_system_log(
                        app,
                        profile_id,
                        LogLevel::Error,
                        snapshot.last_error.clone().unwrap_or(exit_message),
                    );
                    return;
                }

                let mut consecutive_crashes = process.consecutive_crashes;
                let mut reconnect_attempt = process.reconnect_attempt;
                if lived >= STABLE_RUNTIME {
                    consecutive_crashes = 0;
                    reconnect_attempt = 0;
                } else if should_count_as_crash(lived) {
                    consecutive_crashes = consecutive_crashes.saturating_add(1);
                }

                if !process.launch.reconnect_enabled || !failed {
                    process.child = None;
                    process.state = if failed {
                        ProcessState::Failed
                    } else {
                        ProcessState::Stopped
                    };
                    process.last_error = failed.then(|| exit_message.clone());
                    let snapshot = process.to_snapshot();
                    drop(guard);
                    events::emit_state(app, &snapshot);
                    self.push_system_log(
                        app,
                        profile_id,
                        if failed { LogLevel::Error } else { LogLevel::Info },
                        snapshot
                            .last_error
                            .clone()
                            .unwrap_or_else(|| "frpc exited".to_string()),
                    );
                    return;
                }

                if tripped_circuit_breaker(consecutive_crashes) {
                    let message = format!(
                        "reconnect circuit breaker tripped after {consecutive_crashes} rapid crashes"
                    );
                    process.child = None;
                    process.state = ProcessState::Failed;
                    process.last_error = Some(message.clone());
                    process.consecutive_crashes = consecutive_crashes;
                    let snapshot = process.to_snapshot();
                    drop(guard);
                    events::emit_state(app, &snapshot);
                    self.push_system_log(app, profile_id, LogLevel::Error, message);
                    return;
                }

                reconnect_attempt = reconnect_attempt.saturating_add(1);
                let delay = reconnect_delay(reconnect_attempt);
                let launch = process.launch.clone();
                process.child = None;
                process.state = ProcessState::Reconnecting;
                process.reconnect_attempt = reconnect_attempt;
                process.consecutive_crashes = consecutive_crashes;
                process.last_error = Some(format!(
                    "{exit_message}; reconnecting in {}s (attempt {reconnect_attempt})",
                    delay.as_secs()
                ));
                let snapshot = process.to_snapshot();
                ReconnectDecision {
                    launch,
                    reconnect_attempt,
                    consecutive_crashes,
                    delay,
                    snapshot,
                    exit_message,
                }
            };

            events::emit_state(app, &decision.snapshot);
            self.push_system_log(
                app,
                profile_id,
                LogLevel::Warn,
                decision
                    .snapshot
                    .last_error
                    .clone()
                    .unwrap_or_else(|| decision.exit_message.clone()),
            );

            if !self.wait_for_reconnect(profile_id, decision.delay) {
                let snapshot = {
                    let mut guard = lock_guard(&self.processes);
                    match guard.get_mut(profile_id) {
                        Some(process) if process.generation == generation => {
                            process.state = ProcessState::Stopped;
                            process.last_error = None;
                            Some(process.to_snapshot())
                        }
                        Some(_) => None,
                        None => Some(super::stopped_snapshot(profile_id)),
                    }
                };
                if let Some(snapshot) = snapshot {
                    events::emit_state(app, &snapshot);
                }
                return;
            }

            match self.spawn_process(
                decision.launch,
                decision.reconnect_attempt,
                decision.consecutive_crashes,
            ) {
                Ok(_) => return,
                Err(error) => {
                    let message = format!("reconnect spawn failed: {}", error.message);
                    {
                        let mut guard = lock_guard(&self.processes);
                        if let Some(process) = guard.get_mut(profile_id) {
                            process.state = ProcessState::Failed;
                            process.last_error = Some(message.clone());
                            let snapshot = process.to_snapshot();
                            drop(guard);
                            events::emit_state(app, &snapshot);
                        }
                    }
                    self.push_system_log(app, profile_id, LogLevel::Error, message);
                    return;
                }
            }
        }
    }

    /// Sleep out the backoff, unless the user stops the profile or replaces it.
    pub(crate) fn wait_for_reconnect(&self, profile_id: &str, delay: Duration) -> bool {
        let deadline = Instant::now() + delay;
        while Instant::now() < deadline {
            {
                let guard = lock_guard(&self.processes);
                match guard.get(profile_id) {
                    Some(process)
                        if process.cancel_reconnect
                            || matches!(
                                process.state,
                                ProcessState::Stopping | ProcessState::Stopped
                            ) =>
                    {
                        return false;
                    }
                    None => return false,
                    _ => {}
                }
            }
            thread::sleep(Duration::from_millis(200));
        }
        let guard = lock_guard(&self.processes);
        match guard.get(profile_id) {
            Some(process) => {
                !process.cancel_reconnect && process.state == ProcessState::Reconnecting
            }
            None => false,
        }
    }

    /// Probe the frps control port, publish latency, and restart the child when
    /// the server stays unreachable.
    pub(crate) fn watch_health(self: &Arc<Self>, app: &AppHandle, profile_id: &str, generation: u64) {
        thread::sleep(LATENCY_INTERVAL);
        let mut last_health = Instant::now();
        let mut last_wall = SystemTime::now();

        loop {
            let wall_now = SystemTime::now();
            let wall_gap = wall_now.duration_since(last_wall).unwrap_or(Duration::ZERO);
            let after_suspend = crate::health::wall_clock_suggests_suspend(wall_gap);
            last_wall = wall_now;

            let (endpoint, allow_restart, urgent) = {
                let mut guard = lock_guard(&self.processes);
                let Some(process) = guard.get_mut(profile_id) else {
                    return;
                };
                if process.generation != generation {
                    return;
                }
                if matches!(
                    process.state,
                    ProcessState::Stopped | ProcessState::Failed | ProcessState::Stopping
                ) {
                    return;
                }
                if process.state != ProcessState::Running || process.launch.server_endpoint.is_empty()
                {
                    (None, false, false)
                } else {
                    let forced = process.force_health;
                    process.force_health = false;
                    let urgent = after_suspend || forced;
                    let allow_restart = process.launch.reconnect_enabled
                        && (urgent
                            || (process.started_at.elapsed() >= HEALTH_GRACE
                                && last_health.elapsed() >= HEALTH_CHECK_INTERVAL));
                    (
                        Some(process.launch.server_endpoint.clone()),
                        allow_restart,
                        urgent,
                    )
                }
            };

            let mut latency = endpoint
                .as_deref()
                .and_then(crate::health::probe_latency_ms);

            if urgent && allow_restart && latency.is_none() && endpoint.is_some() {
                thread::sleep(WAKE_CONFIRM_DELAY);
                latency = endpoint
                    .as_deref()
                    .and_then(crate::health::probe_latency_ms);
            }

            let action = {
                let mut guard = lock_guard(&self.processes);
                let Some(process) = guard.get_mut(profile_id) else {
                    return;
                };
                if process.generation != generation {
                    return;
                }
                if process.state != ProcessState::Running {
                    None
                } else {
                    process.latency_ms = latency;
                    let metrics = MetricsEvent {
                        profile_id: profile_id.to_string(),
                        latency_ms: latency,
                        tunnel_states: process.tunnel_states.values().cloned().collect(),
                    };
                    let killed = if allow_restart {
                        last_health = Instant::now();
                        if latency.is_some() {
                            process.health_failures = 0;
                            false
                        } else {
                            let needed = if urgent { 1 } else { 2 };
                            process.health_failures = process.health_failures.saturating_add(1);
                            if process.health_failures >= needed {
                                process.health_failures = 0;
                                // Kill in place so the exit watcher runs the
                                // normal reconnect path for this generation.
                                process.kill_child_in_place()
                            } else {
                                false
                            }
                        }
                    } else {
                        false
                    };
                    Some((metrics, killed, urgent))
                }
            };

            if let Some((metrics, killed, urgent)) = action {
                events::emit_metrics(app, &metrics);
                if killed {
                    let message = if urgent {
                        "frps unreachable after wake or network change; restarting frpc"
                    } else {
                        "frps unreachable; restarting frpc for recovery"
                    };
                    self.push_system_log(app, profile_id, LogLevel::Warn, message.to_string());
                }
            }

            thread::sleep(LATENCY_INTERVAL);
        }
    }
}

/// Kept next to the loop that uses it so the "wait" duration stays visible.
pub(crate) const STOP_WAIT_STEP: Duration = Duration::from_millis(100);
