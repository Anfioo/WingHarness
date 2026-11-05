//! What the running core does with traffic: its routing mode and the ports it
//! listens on.
//!
//! mihomo takes `mode` from the config it loads, so the user's choice is a
//! runtime setting that nothing on disk keeps for us: it is remembered in
//! `clash.json` and pushed back after every start and every reload.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::api::{authorized, client, offline, text};
use crate::settings;

/// The modes mihomo accepts; anything else is a typo, not a mode.
const MODES: [&str; 3] = ["rule", "global", "direct"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    /// `rule`, `global` or `direct`.
    pub mode: String,
    /// Where other programs reach the proxy over HTTP: the mixed port when the
    /// profile has one, the HTTP port otherwise.
    pub http_port: Option<u16>,
    pub socks_port: Option<u16>,
    pub mixed_port: Option<u16>,
}

pub async fn view() -> Result<RuntimeView, String> {
    let value = get().await?;
    let mixed_port = port(&value, "mixed-port");
    Ok(RuntimeView {
        mode: text(value.get("mode")),
        http_port: mixed_port.or_else(|| port(&value, "port")),
        socks_port: port(&value, "socks-port"),
        mixed_port,
    })
}

async fn get() -> Result<Value, String> {
    let (client, base, secret) = client()?;
    let response = authorized(client.get(format!("{base}/configs")), secret.as_deref())
        .send()
        .await
        .map_err(offline)?;
    if !response.status().is_success() {
        return Err(format!(
            "The core refused the request: HTTP {}",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Cannot read the core's settings: {e}"))
}

pub async fn set_mode(mode: &str) -> Result<(), String> {
    let mode = canonical(mode)?;
    patch_mode(mode).await?;
    settings::set_mode(Some(mode.to_string()))
}

/// Put the remembered mode back on a core that just started or reloaded from a
/// config file. Best effort: a start is not a failure because a mode did not
/// land, and the controller needs a moment to bind after the process spawns.
pub async fn restore_saved_mode() {
    let Some(mode) = settings::load().mode else {
        return;
    };
    for attempt in 0..8 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if patch_mode(&mode).await.is_ok() {
            return;
        }
    }
}

async fn patch_mode(mode: &str) -> Result<(), String> {
    let (client, base, secret) = client()?;
    let response = authorized(
        client
            .patch(format!("{base}/configs"))
            .json(&serde_json::json!({ "mode": mode })),
        secret.as_deref(),
    )
    .send()
    .await
    .map_err(offline)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "The core refused the request: HTTP {}",
            response.status()
        ))
    }
}

fn canonical(mode: &str) -> Result<&'static str, String> {
    let mode = mode.trim().to_ascii_lowercase();
    MODES
        .iter()
        .copied()
        .find(|known| *known == mode)
        .ok_or_else(|| format!("Unknown routing mode: {mode}"))
}

/// Ports are reported as JSON numbers; a profile that leaves one out reports
/// nothing at all, and 0 means "not listening".
fn port(value: &Value, key: &str) -> Option<u16> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_routing_modes_are_accepted() {
        assert_eq!(canonical("rule").unwrap(), "rule");
        assert_eq!(canonical(" GLOBAL ").unwrap(), "global");
        assert_eq!(canonical("direct").unwrap(), "direct");
        assert!(canonical("script").is_err());
        assert!(canonical("").is_err());
    }

    #[test]
    fn the_mixed_port_wins_over_the_http_one() {
        let value: Value = serde_json::json!({ "port": 7890, "mixed-port": 7897, "socks-port": 0 });
        assert_eq!(port(&value, "mixed-port"), Some(7897));
        assert_eq!(port(&value, "socks-port"), None);
        assert_eq!(port(&value, "missing"), None);
    }
}
