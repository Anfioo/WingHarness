// Adapted from Soflution1/McpHub (MIT)

//! Tauri lifecycle wrapper around the gateway.
//!
//! Owns the `ProxyServer` and the SSE accept-loop task. The webview calls
//! `mcphub_start` / `mcphub_stop` / `mcphub_status` (see `commands.rs`) to
//! drive the gateway; the app exit handler calls `stop()` so child MCP
//! processes do not leak.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Instant, SystemTime};
use tokio::task::JoinHandle;

use crate::mcphub::config;
use crate::mcphub::proxy::ProxyServer;
use crate::mcphub::server::{bind_sse_listener, serve_sse};

/// Default SSE port. Matches the upstream standalone binary so existing
/// Cursor / Claude Desktop configs keep working.
pub const DEFAULT_SSE_PORT: u16 = 24680;

/// A running gateway and the moment it started. Holding these together means
/// `is_running()` and the uptime always agree.
struct RunningGateway {
    proxy: Arc<ProxyServer>,
    port: u16,
    started: Instant,
    started_wall: SystemTime,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct McpHubState {
    inner: Mutex<Option<RunningGateway>>,
}

impl McpHubState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the proxy, init background tasks, and spawn the SSE server.
    /// Idempotent — calling start while already running is a no-op.
    pub async fn start(&self) -> Result<(), String> {
        if self.is_running() {
            eprintln!(
                "[McpHub] start() called but already running on port {:?}",
                self.port()
            );
            return Ok(());
        }

        let proxy_config = config::auto_detect();
        eprintln!(
            "[McpHub] Starting gateway with {} servers...",
            proxy_config.servers.len()
        );

        let proxy = Arc::new(ProxyServer::new(proxy_config));
        proxy.init().await;

        let port = DEFAULT_SSE_PORT;
        // Bind before publishing the running flag: a port conflict must surface
        // as a start error, not a UI stuck on "Running" with nothing listening.
        let listener = bind_sse_listener(port).await?;

        let proxy_clone = proxy.clone();
        let task = tokio::spawn(async move {
            serve_sse(listener, proxy_clone).await;
        });

        *self.inner.lock().unwrap() = Some(RunningGateway {
            proxy,
            port,
            started: Instant::now(),
            started_wall: SystemTime::now(),
            task,
        });

        eprintln!("[McpHub] Gateway started on port {}", port);
        Ok(())
    }

    /// Stop the gateway: abort the SSE accept loop, then kill all child MCP
    /// processes. Safe to call even if never started.
    pub async fn stop(&self) {
        // Take the handle out under a short-lived lock — never hold a std
        // MutexGuard across an .await (that would make this future !Send).
        let running = self.inner.lock().unwrap().take();
        if let Some(running) = running {
            running.task.abort();
            running.proxy.shutdown().await;
        }
        eprintln!("[McpHub] Gateway stopped");
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    pub fn port(&self) -> Option<u16> {
        self.inner.lock().unwrap().as_ref().map(|r| r.port)
    }

    pub fn proxy(&self) -> Option<Arc<ProxyServer>> {
        self.inner.lock().unwrap().as_ref().map(|r| r.proxy.clone())
    }

    /// Milliseconds since the gateway started, or 0 when it is not running.
    pub fn uptime_ms(&self) -> u64 {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| r.started.elapsed().as_millis() as u64)
            .unwrap_or(0)
    }

    /// Wall-clock start time, used to anchor the metrics uptime so a UI reload
    /// during the same run still reports a stable value.
    pub fn started_wall(&self) -> Option<SystemTime> {
        self.inner.lock().unwrap().as_ref().map(|r| r.started_wall)
    }
}
