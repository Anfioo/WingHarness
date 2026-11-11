// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Browser-extension loopback RPC.
//!
//! The extension is already deployed against this contract, so the wire format
//! is frozen: `GET /ping`, `POST /add`, bearer `rpc_token`, port from settings.
//! The plumbing around it is wired elsewhere — `lib.rs` calls [`spawn`] during
//! setup and [`stop`] on exit, and `moin_rpc_status` reads [`bound_address`].
//!
//! Contract, for the extension in `extension/`:
//!
//! - `GET /ping` → `200 { "app": "wingharness", "version": "<cargo version>" }`
//! - `POST /add` with `Authorization: Bearer <settings.rpc_token>` → `200 <Task>`
//! - anything else → non-2xx with `{ "error": "<english message>" }`
//! - bound to `127.0.0.1` only, never `0.0.0.0`.
//!
//! Two details of that contract are load-bearing for the extension's "test
//! connection" button, which posts an empty `{}` to `/add` and reads the status:
//! `401` means "wrong token", `400` means "paired, but no URL given", anything
//! else means "not reachable". So the checks run in that order — token, then
//! body, then URL — and never collapse into one code.
//!
//! The HTTP layer is hand-written on `tokio::net` on purpose: one request per
//! connection, no keep-alive, no dependency on `hyper` / `axum`.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::error::MoinResult;
use crate::models::{Settings, Task};
use crate::state::MoinState;

/// Name the extension sees in `/ping`.
///
/// Upstream answered `moin`; the extension only checks `res.ok` and never reads
/// the field, so the WingHarness name is safe here (branding decision A12).
const APP_NAME: &str = "wingharness";

/// Largest request body accepted. The extension posts a URL, a file name and a
/// handful of captured headers, so anything near this is not a real capture.
const MAX_BODY: usize = 1024 * 1024;

/// Cap on the header block, so a peer that never sends `\r\n\r\n` cannot make
/// the server buffer without bound.
const MAX_HEAD: usize = 16 * 1024;

/// Budget for the whole request, not per `read` call — otherwise a client could
/// stay connected forever by dribbling a byte at a time.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

static BOUND: OnceLock<RwLock<Option<SocketAddr>>> = OnceLock::new();
static SHUTDOWN: OnceLock<watch::Sender<bool>> = OnceLock::new();

fn bound_slot() -> &'static RwLock<Option<SocketAddr>> {
    BOUND.get_or_init(|| RwLock::new(None))
}

/// The address the listener is actually serving on, or `None` when it is off.
///
/// `moin_rpc_status` reports this instead of echoing the configured port, so the
/// settings page can tell "enabled but the port was taken" from "listening".
pub fn bound_address() -> Option<SocketAddr> {
    bound_slot().read().ok().and_then(|value| *value)
}

/// Publish (or clear) the bound address. [`serve`] calls this once it owns a
/// listener and again when it stops.
pub fn publish_bound(address: Option<SocketAddr>) {
    if let Ok(mut value) = bound_slot().write() {
        *value = address;
    }
}

/// Start the listener for the lifetime of the app. Called once from `setup`.
pub fn spawn(state: MoinState) {
    let (sender, receiver) = watch::channel(false);
    let _ = SHUTDOWN.set(sender);
    tauri::async_runtime::spawn(async move {
        serve(state, receiver).await;
    });
}

/// Ask the listener to stop accepting connections. Called on `RunEvent::Exit`.
pub fn stop() {
    if let Some(sender) = SHUTDOWN.get() {
        let _ = sender.send(true);
    }
}

/// Serve the extension endpoints until `shutdown` flips.
///
/// `rpc_enabled` and `rpc_port` are read once, at startup: flipping either takes
/// a restart. The token is not read here — [`CaptureSink::settings`] re-reads it
/// per request, so regenerating it locks out the extension immediately.
pub async fn serve(state: MoinState, shutdown: watch::Receiver<bool>) {
    serve_sink(Arc::new(state), shutdown).await;
}

/// The listener itself, over whatever supplies the engine operations.
///
/// Split from [`serve`] only so the wire format can be driven over a real socket
/// in tests without booting a Tauri app; production always passes a [`MoinState`].
async fn serve_sink(sink: Arc<dyn CaptureSink>, mut shutdown: watch::Receiver<bool>) {
    let settings = match sink.settings().await {
        Ok(settings) => settings,
        Err(error) => {
            log::warn!(
                "The browser integration could not read its settings: {error}"
            );
            return;
        }
    };
    if !settings.rpc_enabled {
        log::info!("The browser integration is disabled in settings.");
        return;
    }
    // Loopback only, always. The token is the only thing standing between a
    // local process and the download queue, so this must never widen.
    let addr = SocketAddr::from(([127, 0, 0, 1], settings.rpc_port));
    let listener = match TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            // A taken port is the user's problem to fix, not a reason to die:
            // the rest of the app works fine without browser integration.
            log::warn!("The browser integration could not listen on {addr}: {error}");
            publish_bound(None);
            return;
        }
    };
    let local = listener.local_addr().unwrap_or(addr);
    publish_bound(Some(local));
    log::info!("The browser integration is listening on http://{local}");

    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let sink = sink.clone();
                    tokio::spawn(async move {
                        handle_connection(stream, sink).await;
                    });
                }
                Err(error) => {
                    // Do not spin: a persistent accept error would otherwise
                    // burn a core for the rest of the session.
                    log::warn!("The browser integration could not accept a connection: {error}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            _ = shutdown.changed() => break,
        }
    }

    publish_bound(None);
    log::info!("The browser integration stopped listening.");
}

/// What `/add` needs from the engine.
///
/// A trait rather than a direct [`MoinState`] call so the HTTP layer can be
/// exercised in tests; `MoinState` is the only production implementation.
#[async_trait::async_trait]
trait CaptureSink: Send + Sync {
    /// Settings as they are right now, so a token change applies to the next
    /// request instead of waiting for a restart.
    async fn settings(&self) -> MoinResult<Settings>;

    /// Where a download lands when `settings.download_dir` is empty.
    fn fallback_dir(&self) -> PathBuf;

    /// Queue a captured link, resolving its category first.
    async fn capture(&self, payload: AddPayload) -> MoinResult<Task>;
}

#[async_trait::async_trait]
impl CaptureSink for MoinState {
    async fn settings(&self) -> MoinResult<Settings> {
        Ok(self.engine().await?.settings())
    }

    fn fallback_dir(&self) -> PathBuf {
        self.downloads_dir.clone()
    }

    async fn capture(&self, payload: AddPayload) -> MoinResult<Task> {
        let engine = self.engine().await?;
        let dir = engine
            .settings()
            .download_dir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.fallback_dir());
        // The extension never picks a category, so run the same matching rules a
        // manual add uses, as a browser capture. An explicit id still wins.
        let category = match payload.category {
            Some(id) => Some(id),
            None => engine.categorize_capture(&payload.url, payload.filename.as_deref()),
        };
        engine
            .add_http(payload.url, dir, category, payload.headers, payload.filename)
            .await
    }
}

/// The JSON body of a `POST /add`. Only `url` matters; everything else refines
/// where and how the download runs.
///
/// Every field is `#[serde(default)]` because the extension sends just
/// `{ url, headers }` — and the connection probe sends `{}`.
#[derive(Debug, Deserialize)]
struct AddPayload {
    #[serde(default)]
    url: String,
    /// The extension does not send this today; a hand-rolled client may.
    #[serde(default)]
    category: Option<String>,
    /// The name the browser would have used, sanitized engine-side.
    #[serde(default)]
    filename: Option<String>,
    /// Captured request headers (Cookie, Referer, User-Agent…) so an auth-gated
    /// link downloads the way the browser would have.
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

/// A parsed request. Only what the two routes need — the version, the raw target
/// and the remaining headers are dropped.
#[derive(Debug)]
struct HttpRequest {
    method: String,
    /// Path with the query string already removed; routing never reads query
    /// parameters, and logging must not see them either.
    path: String,
    /// Header names lower-cased, values trimmed.
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// Why a request could not be turned into an [`HttpRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestError {
    /// Not enough bytes yet. The reader loops on this instead of failing.
    Incomplete,
    /// The request line or a header line is unusable.
    Malformed(&'static str),
    /// Anything but HTTP/1.1.
    UnsupportedVersion,
    /// `Content-Length` is over [`MAX_BODY`], or the headers over [`MAX_HEAD`].
    TooLarge,
    /// The peer stopped talking mid-request.
    TimedOut,
}

impl RequestError {
    fn status(self) -> u16 {
        match self {
            Self::TooLarge => 413,
            _ => 400,
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Incomplete => "the request is incomplete",
            Self::Malformed(reason) => reason,
            Self::UnsupportedVersion => "only HTTP/1.1 is supported",
            Self::TooLarge => "the request is too large",
            Self::TimedOut => "the request timed out",
        }
    }
}

/// Parse one complete request off the wire: request line, headers, then exactly
/// `Content-Length` bytes of body.
///
/// Absent `Content-Length` means an empty body; a short body is [`RequestError::Incomplete`]
/// so the caller can read more, not an error on its own.
fn parse_request(raw: &[u8]) -> Result<HttpRequest, RequestError> {
    let Some(end) = find_head_end(raw) else {
        return Err(if raw.len() > MAX_HEAD {
            RequestError::TooLarge
        } else {
            RequestError::Incomplete
        });
    };

    let head = std::str::from_utf8(&raw[..end])
        .map_err(|_| RequestError::Malformed("the request headers are not valid UTF-8"))?;
    let mut lines = head.split("\r\n");

    let request_line = lines
        .next()
        .ok_or(RequestError::Malformed("the request line is missing"))?;
    let mut fields = request_line.split_whitespace();
    let method = fields
        .next()
        .ok_or(RequestError::Malformed("the request line has no method"))?;
    let target = fields
        .next()
        .ok_or(RequestError::Malformed("the request line has no path"))?;
    let version = fields
        .next()
        .ok_or(RequestError::Malformed("the request line has no HTTP version"))?;
    if fields.next().is_some() {
        return Err(RequestError::Malformed(
            "the request line has extra fields",
        ));
    }
    if !version.eq_ignore_ascii_case("HTTP/1.1") {
        return Err(RequestError::UnsupportedVersion);
    }

    let mut headers = BTreeMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or(RequestError::Malformed("a header line has no colon"))?;
        let name = name.trim();
        if name.is_empty() {
            return Err(RequestError::Malformed("a header line has no name"));
        }
        headers.insert(name.to_ascii_lowercase(), value.trim().to_string());
    }

    let declared = match headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| RequestError::Malformed("Content-Length is not a number"))?,
        None => 0,
    };
    if declared > MAX_BODY {
        return Err(RequestError::TooLarge);
    }
    let body = raw
        .get(end..end + declared)
        .ok_or(RequestError::Incomplete)?
        .to_vec();

    Ok(HttpRequest {
        method: method.to_string(),
        path: target.split('?').next().unwrap_or(target).to_string(),
        headers,
        body,
    })
}

/// Byte offset just past the blank line that ends the headers.
fn find_head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

/// Read one request, bounded in both size and time.
///
/// `Ok(None)` means the peer hung up without saying anything, which is normal
/// for a probe that opened and closed a socket.
async fn read_request(stream: &mut TcpStream) -> Result<Option<HttpRequest>, RequestError> {
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut buffer: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 8 * 1024];

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(RequestError::TimedOut);
        }
        let read = match tokio::time::timeout(remaining, stream.read(&mut chunk)).await {
            Ok(Ok(read)) => read,
            // A reset socket is not worth a response.
            Ok(Err(_)) => return Ok(None),
            Err(_) => return Err(RequestError::TimedOut),
        };
        if read == 0 {
            return if buffer.is_empty() {
                Ok(None)
            } else {
                Err(RequestError::Malformed(
                    "the connection closed before the request was complete",
                ))
            };
        }
        buffer.extend_from_slice(&chunk[..read]);

        match parse_request(&buffer) {
            Ok(request) => return Ok(Some(request)),
            Err(RequestError::Incomplete) => continue,
            Err(error) => return Err(error),
        }
    }
}

/// A response, encoded with the CORS headers the extension needs on every path
/// (including the error ones, or the browser hides the real status).
struct Response {
    status: u16,
    body: Vec<u8>,
}

impl Response {
    fn json<T: Serialize>(status: u16, value: &T) -> Self {
        let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
        Self { status, body }
    }

    fn error(status: u16, message: &str) -> Self {
        Self::json(status, &serde_json::json!({ "error": message }))
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            body: Vec::new(),
        }
    }

    /// One `Connection: close` response. The listener never keeps a connection
    /// alive, which keeps the state machine to "read one request, write one
    /// response, hang up".
    fn encode(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.body.len() + 256);
        out.extend_from_slice(
            format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status)).as_bytes(),
        );
        out.extend_from_slice(b"Access-Control-Allow-Origin: *\r\n");
        out.extend_from_slice(b"Access-Control-Allow-Headers: Authorization, Content-Type\r\n");
        out.extend_from_slice(b"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        if !self.body.is_empty() {
            out.extend_from_slice(b"Content-Type: application/json\r\n");
        }
        out.extend_from_slice(format!("Content-Length: {}\r\n", self.body.len()).as_bytes());
        out.extend_from_slice(b"Connection: close\r\n\r\n");
        out.extend_from_slice(&self.body);
        out
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    }
}

async fn handle_connection(mut stream: TcpStream, sink: Arc<dyn CaptureSink>) {
    let response = match read_request(&mut stream).await {
        Ok(Some(request)) => dispatch(&request, sink.as_ref()).await,
        Ok(None) => return,
        Err(error) => Response::error(error.status(), error.message()),
    };
    // A failed write means the browser already went away; there is nobody left
    // to tell, so this is not worth a log line above debug.
    if let Err(error) = stream.write_all(&response.encode()).await {
        log::debug!("The browser integration could not answer a request: {error}");
    }
    let _ = stream.shutdown().await;
}

async fn dispatch(request: &HttpRequest, sink: &dyn CaptureSink) -> Response {
    match (request.method.as_str(), request.path.as_str()) {
        // Preflight carries no credentials, so it is answered before any check.
        ("OPTIONS", _) => Response::empty(204),
        ("GET", "/ping") => Response::json(
            200,
            &Ping {
                app: APP_NAME,
                version: env!("CARGO_PKG_VERSION"),
            },
        ),
        ("POST", "/add") => handle_add(request, sink).await,
        ("GET", "/add") | ("POST", "/ping") => Response::error(405, "method not allowed"),
        _ => Response::error(404, "not found"),
    }
}

/// The `/ping` body. Unauthenticated on purpose: it lets the extension's options
/// page confirm the app is running before a token has been entered, and it
/// reveals nothing but the name and the version.
#[derive(Serialize)]
struct Ping {
    app: &'static str,
    version: &'static str,
}

async fn handle_add(request: &HttpRequest, sink: &dyn CaptureSink) -> Response {
    let settings = match sink.settings().await {
        Ok(settings) => settings,
        Err(error) => {
            log::warn!("The browser integration could not read its settings: {error}");
            return Response::error(500, "the download engine is unavailable");
        }
    };

    // Token first. The extension probes `/add` with `{}` and reads 401 as "wrong
    // token" but 400 as "paired, just no URL" — checking the body first would
    // make every probe look like a bad token.
    if !authorize(request.header("authorization"), &settings.rpc_token) {
        return Response::error(401, "bad or missing token");
    }

    let payload: AddPayload = match serde_json::from_slice(&request.body) {
        Ok(payload) => payload,
        Err(_) => return Response::error(400, "the request body is not valid JSON"),
    };

    let url = payload.url.trim().to_string();
    if url.is_empty() {
        return Response::error(400, "the request has no url");
    }
    // No torrent engine in this build, and a browser-only `blob:` / `file:` URL
    // cannot be fetched by anything but that browser.
    if !is_supported_url(&url) {
        return Response::error(400, "only http(s) links are supported");
    }

    let payload = AddPayload {
        url,
        // An empty string is the extension's way of saying "no preference".
        category: payload
            .category
            .filter(|value| !value.trim().is_empty()),
        filename: payload
            .filename
            .filter(|value| !value.trim().is_empty()),
        headers: payload.headers,
    };
    let url = payload.url.clone();

    match sink.capture(payload).await {
        Ok(task) => {
            log::info!("The browser integration queued {}.", redact(&url));
            Response::json(200, &task)
        }
        Err(error) => {
            // The message goes to the extension verbatim; only the code is
            // logged, because the message can quote the URL back.
            log::warn!(
                "The browser integration rejected {} ({:?}).",
                redact(&url),
                error.code
            );
            Response::error(400, &error.message)
        }
    }
}

/// Whether the `Authorization` header carries the configured token.
///
/// An empty configured token never matches: a mis-seeded token must not turn the
/// endpoint into an open door.
fn authorize(presented: Option<&str>, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    match presented.and_then(|value| value.strip_prefix("Bearer ")) {
        Some(value) => value == token,
        None => false,
    }
}

/// Only `http` and `https` can be handed to the HTTP engine. `magnet:`, `file:`,
/// `blob:` and friends have no backend behind them.
fn is_supported_url(url: &str) -> bool {
    let trimmed = url.trim().as_bytes();
    let scheme_len = if starts_with_ignore_case(trimmed, b"https://") {
        8
    } else if starts_with_ignore_case(trimmed, b"http://") {
        7
    } else {
        return false;
    };
    // A bare `http://` has no host to connect to.
    trimmed.len() > scheme_len
}

fn starts_with_ignore_case(value: &[u8], prefix: &[u8]) -> bool {
    value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `host/path` for a log line: scheme, credentials, query string and fragment
/// all dropped, so a token passed in `?token=…` never reaches a log file.
fn redact(url: &str) -> String {
    let trimmed = url.trim();
    let after_scheme = match trimmed.find("://") {
        Some(index) => &trimmed[index + 3..],
        None => trimmed,
    };
    let split = after_scheme
        .find(|character| character == '/' || character == '?' || character == '#')
        .unwrap_or(after_scheme.len());
    let (authority, tail) = after_scheme.split_at(split);
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let end = tail
        .find(|character| character == '?' || character == '#')
        .unwrap_or(tail.len());
    format!("{host}{}", &tail[..end])
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::models::{TaskKind, TaskStatus};

    #[test]
    fn parses_a_post_with_headers_and_a_body() {
        let raw = b"POST /add HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer abc\r\nContent-Length: 2\r\n\r\n{}";
        let request = parse_request(raw).expect("a well-formed request");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/add");
        assert_eq!(request.header("authorization"), Some("Bearer abc"));
        assert_eq!(request.body, b"{}");
    }

    #[test]
    fn keeps_header_names_case_insensitive() {
        let raw = b"GET /ping HTTP/1.1\r\nContent-Type: application/json\r\n\r\n";
        let request = parse_request(raw).expect("a well-formed request");
        assert_eq!(request.header("content-type"), Some("application/json"));
    }

    #[test]
    fn a_missing_content_length_means_an_empty_body() {
        let raw = b"GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert!(parse_request(raw).expect("a well-formed request").body.is_empty());
    }

    #[test]
    fn drops_the_query_string_from_the_path() {
        let raw = b"GET /ping?probe=1 HTTP/1.1\r\n\r\n";
        assert_eq!(parse_request(raw).expect("a well-formed request").path, "/ping");
    }

    #[test]
    fn a_body_over_one_mebibyte_is_refused() {
        let raw = format!("POST /add HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert_eq!(
            parse_request(raw.as_bytes()).unwrap_err(),
            RequestError::TooLarge
        );
    }

    #[test]
    fn a_truncated_body_asks_for_more_bytes() {
        let raw = b"POST /add HTTP/1.1\r\nContent-Length: 10\r\n\r\n{}";
        assert_eq!(
            parse_request(raw).unwrap_err(),
            RequestError::Incomplete
        );
    }

    #[test]
    fn rejects_anything_but_http_1_1() {
        let raw = b"GET /ping HTTP/1.0\r\n\r\n";
        assert_eq!(
            parse_request(raw).unwrap_err(),
            RequestError::UnsupportedVersion
        );
    }

    #[test]
    fn an_empty_token_never_authorizes() {
        assert!(!authorize(Some("Bearer anything"), ""));
        assert!(!authorize(None, ""));
    }

    #[test]
    fn a_wrong_or_missing_token_is_rejected() {
        assert!(!authorize(None, "secret"));
        assert!(!authorize(Some("Bearer other"), "secret"));
        assert!(!authorize(Some("secret"), "secret"));
        assert!(!authorize(Some("Bearer "), "secret"));
    }

    #[test]
    fn the_matching_token_authorizes() {
        assert!(authorize(Some("Bearer secret"), "secret"));
    }

    #[test]
    fn accepts_http_and_https_only() {
        assert!(is_supported_url("https://example.com/a.zip"));
        assert!(is_supported_url("http://example.com"));
        assert!(is_supported_url("HTTPS://EXAMPLE.COM/a.zip"));
        assert!(is_supported_url("  https://example.com/a.zip  "));
        assert!(!is_supported_url("magnet:?xt=urn:btih:abc"));
        assert!(!is_supported_url("file:///C:/a.zip"));
        assert!(!is_supported_url("blob:https://example.com/abc"));
        assert!(!is_supported_url("https://"));
        assert!(!is_supported_url(""));
        assert!(!is_supported_url("   "));
    }

    #[test]
    fn redaction_keeps_host_and_path_only() {
        assert_eq!(
            redact("https://example.com/files/a.zip?token=s3cret#frag"),
            "example.com/files/a.zip"
        );
        assert_eq!(redact("https://user:pass@example.com/a.zip"), "example.com/a.zip");
        assert_eq!(redact("https://example.com?x=1"), "example.com");
    }

    struct StubSink {
        settings: Settings,
        captured: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl CaptureSink for StubSink {
        async fn settings(&self) -> MoinResult<Settings> {
            Ok(self.settings.clone())
        }

        fn fallback_dir(&self) -> PathBuf {
            PathBuf::from("downloads")
        }

        async fn capture(&self, payload: AddPayload) -> MoinResult<Task> {
            if let Ok(mut captured) = self.captured.lock() {
                captured.push(payload.url.clone());
            }
            Ok(stub_task(&payload.url))
        }
    }

    fn stub_task(url: &str) -> Task {
        Task {
            id: "task-1".to_string(),
            kind: TaskKind::Http,
            url: url.to_string(),
            filename: "a.zip".to_string(),
            dest: "downloads/a.zip".to_string(),
            status: TaskStatus::Queued,
            total: None,
            received: 0,
            error: None,
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            archived: false,
            active_ms: 0,
            backend: Some("embedded".to_string()),
            category: None,
            final_dir: None,
            headers: BTreeMap::new(),
        }
    }

    /// Drives the real listener over a real socket. Ignored by default because
    /// it binds a port; run with `cargo test -p moin-core -- --ignored`.
    #[tokio::test]
    #[ignore = "binds a loopback port"]
    async fn serves_ping_and_add_over_loopback() {
        publish_bound(None);
        let mut settings = Settings::default();
        // Port 0 lets the OS pick a free one; `bound_address` reports the real
        // port, which is exactly what the settings page shows.
        settings.rpc_port = 0;
        settings.rpc_token = "test-token".to_string();
        let sink: Arc<dyn CaptureSink> = Arc::new(StubSink {
            settings,
            captured: Mutex::new(Vec::new()),
        });

        let (sender, receiver) = watch::channel(false);
        let server = tokio::spawn(serve_sink(sink, receiver));
        let address = loop {
            if let Some(address) = bound_address() {
                break address;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let base = format!("http://{address}");
        let client = reqwest::Client::new();

        let ping = client
            .get(format!("{base}/ping"))
            .send()
            .await
            .expect("a ping response");
        assert_eq!(ping.status(), 200);
        assert_eq!(
            ping.headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
        let body: serde_json::Value = ping.json().await.expect("a ping body");
        assert_eq!(body["app"], APP_NAME);
        assert!(body["version"].as_str().is_some_and(|value| !value.is_empty()));

        let preflight = client
            .request(reqwest::Method::OPTIONS, format!("{base}/add"))
            .send()
            .await
            .expect("a preflight response");
        assert_eq!(preflight.status(), 204);

        let anonymous = client
            .post(format!("{base}/add"))
            .body("{}")
            .send()
            .await
            .expect("an unauthorized response");
        assert_eq!(anonymous.status(), 401);

        // The extension's connection probe: paired, but no URL.
        let unpaired = client
            .post(format!("{base}/add"))
            .bearer_auth("test-token")
            .body("{}")
            .send()
            .await
            .expect("a probe response");
        assert_eq!(unpaired.status(), 400);
        let body: serde_json::Value = unpaired.json().await.expect("an error body");
        assert!(body["error"].is_string());

        let magnet = client
            .post(format!("{base}/add"))
            .bearer_auth("test-token")
            .json(&serde_json::json!({ "url": "magnet:?xt=urn:btih:abc" }))
            .send()
            .await
            .expect("a magnet response");
        assert_eq!(magnet.status(), 400);

        let accepted = client
            .post(format!("{base}/add"))
            .bearer_auth("test-token")
            .json(&serde_json::json!({
                "url": "https://example.com/a.zip",
                "filename": "a.zip",
                "headers": { "Referer": "https://example.com" }
            }))
            .send()
            .await
            .expect("an add response");
        assert_eq!(accepted.status(), 200);
        let task: serde_json::Value = accepted.json().await.expect("a task body");
        assert_eq!(task["id"], "task-1");
        assert_eq!(task["url"], "https://example.com/a.zip");

        let unknown = client
            .get(format!("{base}/nope"))
            .send()
            .await
            .expect("a 404 response");
        assert_eq!(unknown.status(), 404);

        let _ = sender.send(true);
        server.await.expect("the listener task");
        assert!(bound_address().is_none());
    }
}
