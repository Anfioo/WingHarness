//! The HTTP send path: method, headers, query, body, timeout, redirects,
//! decompression and multipart, plus response normalization.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures_util::future::{select, Either};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::multipart::{Form, Part};
use reqwest::{Client, Method};

use crate::cancel::CancelToken;
use crate::error::{AppError, AppResult};
use crate::models::{AuthKind, BodyKind, HttpResponse, KeyValue, RequestBody, SendRequest};

/// Response bodies are read up to this many bytes; anything beyond is dropped
/// and the response is flagged `truncated`.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// Default per-request timeout when the request does not set one.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Redirects are followed at most this many times.
const MAX_REDIRECTS: usize = 10;

/// Send a request and normalize the response for display.
///
/// The URL scheme must be `http`/`https`. The call races the network exchange
/// against `token`: if the request is cancelled, it resolves to
/// [`AppError::Cancelled`] and the connection is dropped.
pub async fn send(request: SendRequest, token: CancelToken) -> AppResult<HttpResponse> {
    let url = reqwest::Url::parse(&request.url)?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::other(format!(
                "unsupported URL scheme {other:?}; only http and https are allowed"
            )))
        }
    }

    let method = Method::from_bytes(request.method.to_uppercase().as_bytes())
        .map_err(|error| AppError::other(format!("invalid HTTP method: {error}")))?;

    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let policy = if request.follow_redirects.unwrap_or(true) {
        reqwest::redirect::Policy::limited(MAX_REDIRECTS)
    } else {
        reqwest::redirect::Policy::none()
    };
    let client = Client::builder()
        .timeout(timeout)
        .redirect(policy)
        .build()?;

    let mut builder = client.request(method, url);

    // Query params — only enabled rows, in order.
    let params: Vec<(&str, &str)> = request
        .params
        .iter()
        .filter(|row| row.enabled)
        .map(|row| (row.key.as_str(), row.value.as_str()))
        .collect();
    if !params.is_empty() {
        builder = builder.query(&params);
    }

    // Explicit request headers.
    for row in request.headers.iter().filter(|row| row.enabled) {
        let (name, value) = header_pair(&row.key, &row.value)?;
        builder = builder.header(name, value);
    }

    // Authentication.
    match request.auth.kind {
        AuthKind::None => {}
        AuthKind::Bearer if !request.auth.token.is_empty() => {
            let value = HeaderValue::from_str(&format!("Bearer {}", request.auth.token))
                .map_err(|_| AppError::other("invalid bearer token value"))?;
            builder = builder.header(AUTHORIZATION, value);
        }
        AuthKind::Basic => {
            builder = builder.basic_auth(
                request.auth.username.clone(),
                Some(request.auth.password.clone()),
            );
        }
        AuthKind::ApiKey if !request.auth.api_key_name.is_empty() => {
            let (name, value) =
                header_pair(&request.auth.api_key_name, &request.auth.api_key_value)?;
            builder = builder.header(name, value);
        }
        _ => {}
    }

    // Body.
    match request.body.kind {
        BodyKind::None => {}
        BodyKind::Json => {
            builder = builder
                .header(CONTENT_TYPE, "application/json")
                .body(request.body.text.clone());
        }
        BodyKind::Raw => {
            let content_type = if request.body.raw_content_type.is_empty() {
                "text/plain"
            } else {
                request.body.raw_content_type.as_str()
            };
            let value = HeaderValue::from_str(content_type)
                .map_err(|_| AppError::other("invalid raw content type"))?;
            builder = builder
                .header(CONTENT_TYPE, value)
                .body(request.body.text.clone());
        }
        BodyKind::Form => {
            let pairs: Vec<(&str, &str)> = request
                .body
                .rows
                .iter()
                .filter(|row| row.enabled)
                .map(|row| (row.key.as_str(), row.value.as_str()))
                .collect();
            builder = builder.form(&pairs);
        }
        BodyKind::Multipart => {
            let form = build_multipart(&request.body).await?;
            builder = builder.multipart(form);
        }
    }

    // Building once lets us report the headers that will actually go out,
    // including the content type / auth the engine itself added.
    let built = builder.build()?;
    let request_headers: Vec<KeyValue> = built
        .headers()
        .iter()
        .map(|(name, value)| KeyValue {
            key: name.as_str().to_string(),
            value: value.to_str().unwrap_or("").to_string(),
            enabled: true,
        })
        .collect();

    let started = Instant::now();
    // Race the exchange against cancellation. `futures_util::future::select` is
    // used instead of `tokio::select!` so the crate does not need tokio's
    // `macros` feature.
    let mut send_future = Box::pin(client.execute(built));
    let mut cancel_future = Box::pin(token.cancelled());
    let mut response = match select(send_future.as_mut(), cancel_future.as_mut()).await {
        Either::Left((result, _)) => result?,
        Either::Right((_, _)) => return Err(AppError::Cancelled),
    };

    let status = response.status();
    let status_code = status.as_u16();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let final_url = response.url().as_str().to_string();
    let response_headers: Vec<KeyValue> = response
        .headers()
        .iter()
        .map(|(name, value)| KeyValue {
            key: name.as_str().to_string(),
            value: value.to_str().unwrap_or("").to_string(),
            enabled: true,
        })
        .collect();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Read the body, capped, racing each chunk against cancellation.
    let mut buffer: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        if buffer.len() >= MAX_BODY_BYTES {
            truncated = true;
            break;
        }
        let mut chunk_future = Box::pin(response.chunk());
        let mut chunk_cancel = Box::pin(token.cancelled());
        let chunk = match select(chunk_future.as_mut(), chunk_cancel.as_mut()).await {
            Either::Left((chunk, _)) => chunk?,
            Either::Right((_, _)) => return Err(AppError::Cancelled),
        };
        match chunk {
            Some(chunk) => {
                let remaining = MAX_BODY_BYTES - buffer.len();
                if chunk.len() > remaining {
                    buffer.extend_from_slice(&chunk[..remaining]);
                    truncated = true;
                    break;
                }
                buffer.extend_from_slice(&chunk);
            }
            None => break,
        }
    }
    let duration_ms = started.elapsed().as_millis() as u64;

    let is_binary = !is_text_content_type(&content_type);
    let (body_text, body_base64) = if is_binary {
        (None, Some(encode_base64(&buffer)))
    } else {
        (Some(String::from_utf8_lossy(&buffer).into_owned()), None)
    };

    Ok(HttpResponse {
        status: status_code,
        status_text,
        request_headers,
        headers: response_headers,
        final_url,
        body_text,
        body_base64,
        content_type,
        is_binary,
        size_bytes: buffer.len() as u64,
        duration_ms,
        truncated,
    })
}

/// Parse a header name/value pair, surfacing invalid input as an error rather
/// than panicking inside reqwest.
fn header_pair(name: &str, value: &str) -> AppResult<(HeaderName, HeaderValue)> {
    let name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| AppError::other(format!("invalid header name: {name:?}")))?;
    let value = HeaderValue::from_str(value)
        .map_err(|_| AppError::other(format!("invalid value for header {name:?}")))?;
    Ok((name, value))
}

/// Build a `multipart/form-data` body. Rows whose key appears in `file_paths`
/// are file fields; the rest are text fields. File reads run on the blocking
/// pool because `std::fs` is synchronous under the hood.
async fn build_multipart(body: &RequestBody) -> AppResult<Form> {
    let mut form = Form::new();
    for row in body.rows.iter().filter(|row| row.enabled) {
        match body
            .file_paths
            .get(&row.key)
            .filter(|path| !path.is_empty())
        {
            Some(path) => {
                let source = PathBuf::from(path);
                let file_name = source
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| row.value.clone());
                let read_path = source.clone();
                let bytes = tokio::task::spawn_blocking(move || std::fs::read(&read_path))
                    .await
                    .map_err(|error| {
                        AppError::other(format!("multipart read task failed: {error}"))
                    })??;
                let part = Part::bytes(bytes).file_name(file_name);
                form = form.part(row.key.clone(), part);
            }
            None => {
                form = form.part(row.key.clone(), Part::text(row.value.clone()));
            }
        }
    }
    Ok(form)
}

/// Decide text vs. binary from the response content type. Anything not in the
/// known text family (and an absent content type) is treated as binary.
fn is_text_content_type(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if essence.is_empty() {
        return false;
    }
    essence.starts_with("text/")
        || essence == "application/json"
        || essence.ends_with("+json")
        || essence == "application/xml"
        || essence.ends_with("+xml")
        || essence == "application/x-www-form-urlencoded"
        || essence == "application/javascript"
        || essence == "application/ecmascript"
        || essence == "application/x-yaml"
        || essence == "application/yaml"
        || essence.ends_with("+yaml")
        || essence == "image/svg+xml"
}

/// Standard-alphabet base64 with padding. Kept local so the crate needs no
/// extra dependency for the one place it is used.
fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn text_content_types_are_recognized() {
        assert!(is_text_content_type("text/plain; charset=utf-8"));
        assert!(is_text_content_type("application/json"));
        assert!(is_text_content_type("application/problem+json"));
        assert!(is_text_content_type("application/xml"));
        assert!(is_text_content_type("text/csv"));
        assert!(is_text_content_type("image/svg+xml"));
        assert!(!is_text_content_type("application/octet-stream"));
        assert!(!is_text_content_type("image/png"));
        assert!(!is_text_content_type(""));
    }
}
