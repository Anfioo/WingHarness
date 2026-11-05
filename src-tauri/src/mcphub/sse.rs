// Adapted from Soflution1/McpHub (MIT)

/// SSE transport for MCP protocol.
/// Allows clients (Cursor, Claude Desktop) to connect via HTTP instead of stdio.
/// Sessions are managed via channels for zero-copy message passing.
///
/// Safety:
/// - Application-level keepalive every 15s detects half-open connections
/// - Session reaper cleans stale sessions every 60s
/// - Write + flush errors both trigger session teardown
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};

use crate::mcphub::protocol::JsonRpcRequest;
use crate::mcphub::proxy::ProxyServer;

/// A single SSE client session.
struct SseSession {
    tx: mpsc::Sender<String>,
    last_activity: Instant,
}

/// Manages all active SSE sessions.
pub struct SseManager {
    sessions: Arc<Mutex<HashMap<String, SseSession>>>,
    /// Shared live-connection counter, bumped on connect and dropped on
    /// disconnect/reap so the dashboard can read it via the proxy.
    active_sessions: Arc<AtomicUsize>,
}

/// Max time a session can be idle before reaper kills it (5 minutes).
const SESSION_TIMEOUT_SECS: u64 = 300;
/// Reaper interval.
const REAPER_INTERVAL_SECS: u64 = 60;
/// SSE keepalive interval.
const KEEPALIVE_INTERVAL_SECS: u64 = 15;

impl SseManager {
    /// Build a new manager. `active_sessions` is shared with the proxy so the
    /// metrics command can report the live connection count.
    pub fn new(active_sessions: Arc<AtomicUsize>) -> Self {
        let manager = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            active_sessions,
        };
        // Start session reaper
        let sessions_ref = manager.sessions.clone();
        let counter_ref = manager.active_sessions.clone();
        tokio::spawn(async move {
            session_reaper(sessions_ref, counter_ref).await;
        });
        manager
    }

    /// Handle GET /sse — establish long-lived SSE connection.
    /// Sends endpoint event, then streams responses until client disconnects.
    pub async fn handle_connect(&self, mut stream: TcpStream) {
        let session_id = generate_session_id();

        // SSE response headers
        let headers = "HTTP/1.1 200 OK\r\n\
             Content-Type: text/event-stream\r\n\
             Cache-Control: no-cache\r\n\
             Connection: keep-alive\r\n\
             Access-Control-Allow-Origin: *\r\n\
             \r\n";

        if stream.write_all(headers.as_bytes()).await.is_err() {
            return;
        }

        // Send endpoint event — tells client where to POST messages
        let endpoint_event = format!(
            "event: endpoint\ndata: /message?sessionId={}\n\n",
            session_id
        );
        if write_and_flush(&mut stream, endpoint_event.as_bytes())
            .await
            .is_err()
        {
            return;
        }

        eprintln!("[McpHub][SSE] Client connected: {}", session_id);

        // Create channel for this session (bounded: backpressure if client is slow)
        let (tx, mut rx) = mpsc::channel::<String>(64);

        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                session_id.clone(),
                SseSession {
                    tx,
                    last_activity: Instant::now(),
                },
            );
            self.active_sessions.fetch_add(1, Ordering::Relaxed);
        }

        // Stream events until disconnect.
        // Keepalive every 15s to detect dead connections.
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(event) => {
                            if write_and_flush(&mut stream, event.as_bytes()).await.is_err() {
                                break;
                            }
                        }
                        None => break, // Channel dropped (session reaped or server shutdown)
                    }
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(KEEPALIVE_INTERVAL_SECS)) => {
                    if write_and_flush(&mut stream, b": keepalive\n\n").await.is_err() {
                        break;
                    }
                }
            }
        }

        // Cleanup: remove session from map and drop the live-connection count.
        {
            let mut sessions = self.sessions.lock().await;
            if sessions.remove(&session_id).is_some() {
                self.active_sessions.fetch_sub(1, Ordering::Relaxed);
            }
        }
        // Explicitly shutdown the socket
        let _ = stream.shutdown().await;
        eprintln!("[McpHub][SSE] Client disconnected: {}", session_id);
    }

    /// Handle POST /message?sessionId=xxx — process JSON-RPC and send response via SSE.
    /// Returns HTTP response bytes (202 Accepted or error).
    pub async fn handle_message(
        &self,
        session_id: &str,
        body: &str,
        proxy: &Arc<ProxyServer>,
    ) -> Vec<u8> {
        // Parse JSON-RPC request
        let request: JsonRpcRequest = match serde_json::from_str(body) {
            Ok(r) => r,
            Err(e) => {
                return http_response(
                    400,
                    "Bad Request",
                    &format!("{{\"error\":\"Invalid JSON-RPC: {}\"}}", e),
                );
            }
        };

        let has_id = request.id.is_some();

        // Process through proxy
        let response = proxy.handle_request(request).await;

        // Send response through SSE stream
        if let Some(resp) = response {
            let json = match serde_json::to_string(&resp) {
                Ok(j) => j,
                Err(e) => {
                    eprintln!("[McpHub][SSE] Serialize error: {}", e);
                    return http_response(
                        500,
                        "Internal Server Error",
                        "{\"error\":\"Serialize failed\"}",
                    );
                }
            };

            let event = format!("event: message\ndata: {}\n\n", json);

            // Update last_activity and send via channel
            let mut sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get_mut(session_id) {
                session.last_activity = Instant::now();
                // try_send: non-blocking, if channel full the client is too slow
                match session.tx.try_send(event) {
                    Ok(_) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        eprintln!(
                            "[McpHub][SSE] Session {} channel full, dropping message",
                            session_id
                        );
                        // Don't kill the session, just drop this message
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        drop(sessions);
                        // Session is dead, clean it up and drop the live count.
                        let mut sessions = self.sessions.lock().await;
                        if sessions.remove(session_id).is_some() {
                            self.active_sessions.fetch_sub(1, Ordering::Relaxed);
                        }
                        return http_response(410, "Gone", "{\"error\":\"Session closed\"}");
                    }
                }
            } else {
                return http_response(404, "Not Found", "{\"error\":\"Session not found\"}");
            }
        }

        // Return 202 Accepted for requests, 200 for notifications
        if has_id {
            http_response(202, "Accepted", "{\"ok\":true}")
        } else {
            http_response(200, "OK", "{\"ok\":true}")
        }
    }

    /// Get active session count.
    #[allow(dead_code)]
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }
}

impl Default for SseManager {
    fn default() -> Self {
        Self::new(Arc::new(AtomicUsize::new(0)))
    }
}

/// Extract sessionId from query string: /message?sessionId=xxx
pub fn extract_session_id(path: &str) -> Option<String> {
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        if let Some(val) = param.strip_prefix("sessionId=") {
            return Some(val.to_string());
        }
    }
    None
}

/// Write bytes + flush. Returns Err if either fails.
async fn write_and_flush(stream: &mut TcpStream, data: &[u8]) -> Result<(), ()> {
    if stream.write_all(data).await.is_err() {
        return Err(());
    }
    if stream.flush().await.is_err() {
        return Err(());
    }
    Ok(())
}

/// Periodically reap stale sessions (no activity for SESSION_TIMEOUT_SECS).
/// Dropping the sender half of the channel causes the SSE loop to break; each
/// reaped session also drops the shared live-connection counter.
async fn session_reaper(
    sessions: Arc<Mutex<HashMap<String, SseSession>>>,
    active_sessions: Arc<AtomicUsize>,
) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(REAPER_INTERVAL_SECS)).await;
        let mut map = sessions.lock().await;
        let stale: Vec<String> = map
            .iter()
            .filter(|(_, s)| s.last_activity.elapsed().as_secs() > SESSION_TIMEOUT_SECS)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &stale {
            if map.remove(id).is_some() {
                active_sessions.fetch_sub(1, Ordering::Relaxed);
            }
            eprintln!("[McpHub][SSE] Reaped stale session: {}", id);
        }
    }
}

/// Generate a random session ID (no uuid crate needed).
fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{:x}-{:x}-{:x}", nanos, pid, count)
}

fn http_response(status: u16, status_text: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        status,
        status_text,
        body.len(),
        body
    )
    .into_bytes()
}
