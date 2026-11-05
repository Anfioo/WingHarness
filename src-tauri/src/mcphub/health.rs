// Adapted from Soflution1/McpHub (MIT)

/// Health monitor: periodic health checks, auto-restart.
///
/// The upstream project raised native OS toasts (notify-rust / osascript). In
/// the Tauri build we keep the monitoring + restart logic but route alerts
/// through stderr only — the app's own UI / log viewer is the place users see
/// them.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::mcphub::child::ChildManager;

const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_BACKOFF_BASE_MS: u64 = 2000;

pub struct HealthMonitor {
    manager: Arc<ChildManager>,
    check_interval: Duration,
    auto_restart: bool,
    restart_attempts: Arc<tokio::sync::Mutex<HashMap<String, u32>>>,
}

impl HealthMonitor {
    pub fn new(manager: Arc<ChildManager>, check_interval_secs: u64, auto_restart: bool) -> Self {
        Self {
            manager,
            check_interval: Duration::from_secs(check_interval_secs),
            auto_restart,
            restart_attempts: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Run the health monitor loop. Call this as a spawned task.
    pub async fn run(&self) {
        eprintln!(
            "[McpHub][HEALTH] Monitor started: interval={}s, auto_restart={}",
            self.check_interval.as_secs(),
            self.auto_restart
        );

        loop {
            tokio::time::sleep(self.check_interval).await;
            self.check_cycle().await;
        }
    }

    async fn check_cycle(&self) {
        let dead = self.manager.health_check().await;

        if dead.is_empty() {
            return;
        }

        for (name, reason) in &dead {
            eprintln!("[McpHub][HEALTH] Server '{}' is DOWN: {}", name, reason);

            if self.auto_restart {
                self.try_restart(name, reason).await;
            } else {
                self.notify_down(name, reason, false);
            }
        }
    }

    async fn try_restart(&self, name: &str, reason: &str) {
        let mut attempts = self.restart_attempts.lock().await;
        let count = attempts.entry(name.to_string()).or_insert(0);

        if *count >= MAX_RESTART_ATTEMPTS {
            eprintln!(
                "[McpHub][HEALTH] Server '{}' failed {} restart attempts. Giving up.",
                name, MAX_RESTART_ATTEMPTS
            );
            self.notify_down(
                name,
                &format!("{} (failed {} restarts)", reason, count),
                false,
            );
            return;
        }

        *count += 1;
        let attempt = *count;
        drop(attempts);

        // Exponential backoff
        let backoff = Duration::from_millis(RESTART_BACKOFF_BASE_MS * (1 << (attempt - 1)));
        eprintln!(
            "[McpHub][HEALTH] Restarting '{}' (attempt {}/{}, backoff {:?})...",
            name, attempt, MAX_RESTART_ATTEMPTS, backoff
        );
        tokio::time::sleep(backoff).await;

        match self.manager.restart_server(name).await {
            Ok(tool_count) => {
                eprintln!(
                    "[McpHub][HEALTH] Server '{}' restarted OK ({} tools)",
                    name, tool_count
                );
                self.notify_restarted(name, tool_count);
                // Reset attempt counter on success
                let mut attempts = self.restart_attempts.lock().await;
                attempts.remove(name);
            }
            Err(e) => {
                eprintln!("[McpHub][HEALTH] Restart '{}' FAILED: {}", name, e);
                let mut attempts = self.restart_attempts.lock().await;
                let count = attempts.get(name).copied().unwrap_or(0);
                if count >= MAX_RESTART_ATTEMPTS {
                    self.notify_down(name, &format!("{} (all restarts failed)", reason), false);
                }
            }
        }
    }

    fn notify_down(&self, server_name: &str, reason: &str, _restarting: bool) {
        let title = format!("MCP Server Down: {}", server_name);
        let body = format!("{}\n\nThis server's tools are unavailable.", reason);
        send_notification(&title, &body);
    }

    fn notify_restarted(&self, server_name: &str, tool_count: usize) {
        let title = format!("MCP Server Recovered: {}", server_name);
        let body = format!("Auto-restarted successfully with {} tools.", tool_count);
        send_notification(&title, &body);
    }
}

/// Surface a health alert through stderr only. The upstream project used
/// notify-rust / osascript to raise native toasts; in the Tauri build the
/// app's own UI is the notification surface, so we just log.
fn send_notification(title: &str, body: &str) {
    eprintln!("[McpHub][ALERT] {}: {}", title, body);
}
