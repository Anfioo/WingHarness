// Adapted from Soflution1/McpHub (MIT)

//! SSE-only HTTP server for the Tauri build.
//!
//! The upstream project shipped a full embedded dashboard (static HTML + JSON
//! API + SSE) on the same port. In the Tauri build the UI lives in the webview
//! and talks to the gateway through Tauri commands, so we only bind the SSE
//! endpoints that external MCP clients (Cursor, Claude Desktop) need:
//!
//! - `GET  /sse`                       — long-lived SSE stream
//! - `POST /message?sessionId=<id>`    — JSON-RPC POST
//!
//! Everything else (including `/`, `/api/*`, static HTML) returns 404.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::mcphub::proxy::ProxyServer;
use crate::mcphub::sse::{extract_session_id, SseManager};

/// Bind 127.0.0.1:`port` for the SSE server.
///
/// Retries the bind a few times with a short backoff in case the port is in
/// a TIME_WAIT state from a previous run. Returns `Err` if every attempt fails
/// (e.g. another process owns the port) so the caller can report it instead of
/// claiming the gateway is running.
pub async fn bind_sse_listener(port: u16) -> Result<TcpListener, String> {
    let addr = format!("127.0.0.1:{}", port);
    let mut last_err = String::new();
    // Up to 5 attempts, 200ms apart — covers TIME_WAIT / quick restart.
    for attempt in 0..5u32 {
        match TcpListener::bind(&addr).await {
            Ok(l) => {
                eprintln!("[McpHub][HTTP] SSE server ready on http://{}", addr);
                eprintln!("[McpHub][SSE]  Cursor endpoint: http://{}/sse", addr);
                return Ok(l);
            }
            Err(e) => {
                last_err = e.to_string();
                eprintln!(
                    "[McpHub][HTTP] bind {} attempt {}/5 failed: {}",
                    addr,
                    attempt + 1,
                    e
                );
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
    Err(format!("Failed to bind {}: {}", addr, last_err))
}

/// Serve SSE traffic on an already-bound listener, forever.
pub async fn serve_sse(listener: TcpListener, proxy: Arc<ProxyServer>) {
    // Share the proxy's live-session counter so the metrics command can report
    // active connections without the HTTP layer reaching back into the proxy.
    let sse = Arc::new(SseManager::new(proxy.active_sessions_handle()));

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("[McpHub][HTTP] accept error: {}", e);
                continue;
            }
        };

        let proxy_clone = proxy.clone();
        let sse_clone = sse.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, proxy_clone, sse_clone).await {
                eprintln!("[McpHub][HTTP] connection error from {}: {}", peer, e);
            }
        });
    }
}

/// Bind and serve in one call. Kept for callers that do not need the bind
/// result (tests / stdio parity); the Tauri lifecycle uses the split halves so
/// `start()` can surface a bind failure to the UI.
#[allow(dead_code)]
pub async fn start_sse_server(proxy: Arc<ProxyServer>, port: u16) -> Result<(), String> {
    let listener = bind_sse_listener(port).await?;
    serve_sse(listener, proxy).await;
    Ok(())
}

/// Minimal HTTP request parsed off the wire. We only need method/path/body
/// (plus the `Authorization` header for SSE token checks) to route traffic.
struct MiniRequest {
    method: String,
    path: String,
    body: String,
    authorization: Option<String>,
}

async fn read_request(stream: &mut TcpStream) -> Result<Option<MiniRequest>, String> {
    let mut buf = vec![0u8; 65536];
    let mut total_read =
        match tokio::time::timeout(std::time::Duration::from_secs(10), stream.read(&mut buf)).await
        {
            Ok(Ok(n)) if n > 0 => n,
            Ok(_) => return Ok(None),
            Err(_) => return Err("read timeout".into()),
        };

    // Find end of headers
    let mut body_offset = 0;
    for i in 0..total_read.saturating_sub(3) {
        if &buf[i..i + 4] == b"\r\n\r\n" {
            body_offset = i + 4;
            break;
        } else if i < total_read.saturating_sub(1) && &buf[i..i + 2] == b"\n\n" {
            body_offset = i + 2;
            break;
        }
    }

    if body_offset == 0 {
        return Ok(None);
    }

    // Parse Content-Length + Authorization from headers — extract the values
    // as owned strings before we touch buf mutably (from_utf8_lossy borrows buf).
    let mut content_length: usize = 0;
    let mut authorization: Option<String> = None;
    {
        let headers_str = String::from_utf8_lossy(&buf[..body_offset]);
        for line in headers_str.lines() {
            let lower = line.to_ascii_lowercase();
            if let Some(val) = lower.strip_prefix("content-length:") {
                content_length = val.trim().parse().unwrap_or(0);
            } else if lower.starts_with("authorization:") {
                // Header names are ASCII, so the value starts at the same byte
                // offset in `line`; take it from there to preserve token case.
                authorization = Some(line["authorization:".len()..].trim().to_string());
            }
        }
    }

    // Read remaining body bytes if the headers advertised a longer body.
    let target = body_offset + content_length;
    if target > buf.len() {
        buf.resize(target, 0);
    }
    while total_read < target {
        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            stream.read(&mut buf[total_read..]),
        )
        .await
        {
            Ok(Ok(n)) if n > 0 => total_read += n,
            Ok(_) => return Ok(None),
            Err(_) => return Err("body read timeout".into()),
        }
    }

    // First line: METHOD PATH HTTP/1.1
    let headers_str = String::from_utf8_lossy(&buf[..body_offset]);
    let first_line = headers_str.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(None);
    }

    Ok(Some(MiniRequest {
        method: parts[0].to_string(),
        path: parts[1].to_string(),
        body: if content_length > 0 {
            String::from_utf8_lossy(&buf[body_offset..total_read]).to_string()
        } else {
            String::new()
        },
        authorization,
    }))
}

async fn handle_connection(
    mut stream: TcpStream,
    proxy: Arc<ProxyServer>,
    sse: Arc<SseManager>,
) -> Result<(), String> {
    // OPTIONS preflight is handled below once the request line is parsed.
    let req = match read_request(&mut stream).await? {
        Some(r) => r,
        None => return Ok(()),
    };

    if req.method == "OPTIONS" {
        let resp = b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Max-Age: 86400\r\nContent-Length: 0\r\n\r\n";
        stream.write_all(resp).await.map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Strip query string for path matching.
    let path = req.path.split('?').next().unwrap_or(&req.path);

    // Token auth: enforced as soon as any token exists (named store or the
    // legacy auth-token file). A brand-new install with no tokens stays open so
    // existing Cursor / Claude Desktop configs keep working.
    let needs_auth = crate::mcphub::auth::any_tokens_configured();
    if needs_auth {
        let authorized = req
            .authorization
            .as_deref()
            .and_then(crate::mcphub::auth::validate_authorization)
            .is_some();
        if !authorized {
            let resp = http_simple(
                401,
                "Unauthorized",
                "{\"error\":\"Missing or invalid token\"}",
            );
            stream.write_all(&resp).await.map_err(|e| e.to_string())?;
            let _ = stream.shutdown().await;
            return Ok(());
        }
    }

    // GET /sse → long-lived SSE connection.
    if req.method == "GET" && (path == "/sse" || path == "/sse/") {
        sse.handle_connect(stream).await;
        return Ok(());
    }

    // POST /message?sessionId=xxx → JSON-RPC dispatch.
    if req.method == "POST" && path == "/message" {
        let body = if let Some(session_id) = extract_session_id(&req.path) {
            sse.handle_message(&session_id, &req.body, &proxy).await
        } else {
            http_simple(
                400,
                "Bad Request",
                "{\"error\":\"Missing sessionId parameter\"}",
            )
        };
        stream.write_all(&body).await.map_err(|e| e.to_string())?;
        let _ = stream.shutdown().await;
        return Ok(());
    }

    // Anything else (/, /api/*, static files, unknown routes) → 404.
    // The Tauri webview serves its own UI; external clients only need /sse + /message.
    let resp = http_simple(404, "Not Found", "{\"error\":\"Not found\"}");
    stream.write_all(&resp).await.map_err(|e| e.to_string())?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn http_simple(status: u16, status_text: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
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
