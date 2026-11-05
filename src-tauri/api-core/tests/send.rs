//! Integration tests for the send path: real local HTTP server via `httpmock`,
//! real `reqwest` client. Each test drives the async engine on its own minimal
//! runtime (`tokio::select!` is not available to the crate, so tests build the
//! runtime explicitly instead of using `#[tokio::test]`).

use std::time::Duration;

use api_core::test_api as core;
use api_core::AppError;
use httpmock::prelude::*;

/// gzip of the bytes `hello gzip world`, produced with `gzip -n` (stable header).
const GZIP_BODY: &[u8] = &[
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57,
    0x48, 0xaf, 0xca, 0x2c, 0x50, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01, 0x00, 0x6b, 0x7d, 0xe8, 0xb7,
    0x10, 0x00, 0x00, 0x00,
];

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A distinct in-flight id per call: the cancellation registry keys on it, and
/// tests run in parallel threads.
fn next_id() -> String {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    format!("test-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

fn request(method: &str, url: String) -> core::SendRequest {
    core::SendRequest {
        request_id: "test-request".to_string(),
        method: method.to_string(),
        url,
        ..Default::default()
    }
}

fn send(request: core::SendRequest) -> Result<core::HttpResponse, AppError> {
    runtime().block_on(core::send(request, core::register(&next_id())))
}

#[test]
fn get_returns_status_headers_body_and_timing() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(GET).path("/hello").query_param("q", "x y");
        then.status(200)
            .header("content-type", "text/plain; charset=utf-8")
            .header("x-test", "yes")
            .body("hello world");
    });

    let mut req = request("GET", server.url("/hello"));
    req.params = vec![core::KeyValue {
        key: "q".to_string(),
        value: "x y".to_string(),
        enabled: true,
    }];
    req.headers = vec![core::KeyValue {
        key: "x-test".to_string(),
        value: "yes".to_string(),
        enabled: true,
    }];

    let response = send(req).unwrap();
    mock.assert();

    assert_eq!(response.status, 200);
    assert_eq!(response.status_text, "OK");
    assert_eq!(response.body_text.as_deref(), Some("hello world"));
    assert!(response.body_base64.is_none());
    assert!(!response.is_binary);
    assert_eq!(response.size_bytes, 11);
    assert!(response.final_url.ends_with("/hello?q=x+y") || response.final_url.contains("/hello"));
    assert!(response
        .headers
        .iter()
        .any(|h| h.key == "x-test" && h.value == "yes"));
    assert!(response
        .request_headers
        .iter()
        .any(|h| h.key == "x-test" && h.value == "yes"));
    assert!(!response.truncated);
}

#[test]
fn json_post_sends_the_body() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/echo").body("{\"a\":1,\"b\":2}");
        then.status(200)
            .header("content-type", "application/json")
            .json_body(serde_json::json!({ "ok": true }));
    });

    let mut req = request("POST", server.url("/echo"));
    req.body.kind = core::BodyKind::Json;
    req.body.text = "{\"a\":1,\"b\":2}".to_string();

    let response = send(req).unwrap();
    mock.assert();

    assert_eq!(response.status, 200);
    assert!(response.content_type.starts_with("application/json"));
    assert!(response.body_text.as_deref().unwrap().contains("ok"));
    assert!(response
        .request_headers
        .iter()
        .any(|h| h.key == "content-type" && h.value == "application/json"));
}

#[test]
fn form_post_encodes_rows() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path("/form").body("a=1&b=2");
        then.status(201)
            .header("content-type", "text/plain")
            .body("created");
    });

    let mut req = request("POST", server.url("/form"));
    req.body.kind = core::BodyKind::Form;
    req.body.rows = vec![
        core::KeyValue {
            key: "a".to_string(),
            value: "1".to_string(),
            enabled: true,
        },
        core::KeyValue {
            key: "b".to_string(),
            value: "2".to_string(),
            enabled: true,
        },
        core::KeyValue {
            key: "skip".to_string(),
            value: "me".to_string(),
            enabled: false,
        },
    ];

    let response = send(req).unwrap();
    mock.assert();
    assert_eq!(response.status, 201);
    assert_eq!(response.body_text.as_deref(), Some("created"));
}

#[test]
fn redirect_is_followed_by_default() {
    let server = MockServer::start();
    let start = server.mock(|when, then| {
        when.method(GET).path("/start");
        then.status(302).header("location", "/end");
    });
    let end = server.mock(|when, then| {
        when.method(GET).path("/end");
        then.status(200)
            .header("content-type", "text/plain")
            .body("arrived");
    });

    let response = send(request("GET", server.url("/start"))).unwrap();
    start.assert();
    end.assert();

    assert_eq!(response.status, 200);
    assert_eq!(response.body_text.as_deref(), Some("arrived"));
    assert!(response.final_url.ends_with("/end"));
}

#[test]
fn redirect_is_not_followed_when_disabled() {
    let server = MockServer::start();
    let start = server.mock(|when, then| {
        when.method(GET).path("/start");
        then.status(302).header("location", "/end");
    });
    let end = server.mock(|when, then| {
        when.method(GET).path("/end");
        then.status(200)
            .header("content-type", "text/plain")
            .body("arrived");
    });

    let mut req = request("GET", server.url("/start"));
    req.follow_redirects = Some(false);
    let response = send(req).unwrap();
    start.assert();
    end.assert_hits(0);

    assert_eq!(response.status, 302);
    assert!(response.final_url.ends_with("/start"));
}

#[test]
fn gzip_response_is_decompressed() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(GET).path("/gzip");
        then.status(200)
            .header("content-type", "text/plain")
            .header("content-encoding", "gzip")
            .body(GZIP_BODY.to_vec());
    });

    let response = send(request("GET", server.url("/gzip"))).unwrap();
    mock.assert();

    assert_eq!(response.status, 200);
    assert_eq!(response.body_text.as_deref(), Some("hello gzip world"));
    assert_eq!(response.size_bytes, 16);
}

#[test]
fn binary_response_is_base64_encoded() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(GET).path("/bin");
        then.status(200)
            .header("content-type", "application/octet-stream")
            .body(vec![0u8, 1, 2, 255]);
    });

    let response = send(request("GET", server.url("/bin"))).unwrap();
    mock.assert();

    assert!(response.is_binary);
    assert!(response.body_text.is_none());
    assert_eq!(response.body_base64.as_deref(), Some("AAEC/w=="));
    assert_eq!(response.size_bytes, 4);
}

#[test]
fn timeout_surfaces_as_an_http_error() {
    let server = MockServer::start();
    let _mock = server.mock(|when, then| {
        when.method(GET).path("/slow");
        then.status(200)
            .delay(Duration::from_millis(600))
            .body("late");
    });

    let mut req = request("GET", server.url("/slow"));
    req.timeout_ms = Some(100);
    let error = send(req).unwrap_err();
    assert!(matches!(error, AppError::Http(_)), "got {error:?}");
}

#[test]
fn cancel_aborts_an_in_flight_request() {
    let server = MockServer::start();
    let _mock = server.mock(|when, then| {
        when.method(GET).path("/slow");
        then.status(200).delay(Duration::from_secs(5)).body("late");
    });

    let req = request("GET", server.url("/slow"));
    let outcome = runtime().block_on(async move {
        let id = next_id();
        let token = core::register(&id);
        let handle = tokio::spawn(core::send(req, token));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(core::cancel(&id), "the request should be registered");
        handle.await.unwrap()
    });

    assert!(
        matches!(outcome, Err(AppError::Cancelled)),
        "got {outcome:?}"
    );
}

#[test]
fn rejects_non_http_schemes() {
    let error = send(request("GET", "ftp://example.com/x".to_string())).unwrap_err();
    assert!(matches!(error, AppError::Other(_)), "got {error:?}");
}
