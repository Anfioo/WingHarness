//! Talking to the running core's own REST controller.
//!
//! The core answers on the `external-controller` address taken from the output
//! it was started with. Both callers need the same small amount of plumbing: a
//! short-timeout client, the bearer secret, and one message for a core that is
//! not there. Nothing is cached; a core that is down simply refuses the socket.

use std::time::Duration;

use serde_json::Value;

use crate::core;

pub fn client() -> Result<(reqwest::Client, String, Option<String>), String> {
    let (addr, secret) = core::controller()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    Ok((client, format!("http://{addr}"), secret))
}

pub fn authorized(
    request: reqwest::RequestBuilder,
    secret: Option<&str>,
) -> reqwest::RequestBuilder {
    match secret {
        Some(secret) => request.bearer_auth(secret),
        None => request,
    }
}

pub fn offline(error: reqwest::Error) -> String {
    format!("Cannot reach the core; start it first ({error})")
}

pub fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
