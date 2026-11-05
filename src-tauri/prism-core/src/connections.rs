//! The core's live connection list, read from its own REST controller.
//!
//! mihomo answers `/connections` on `external-controller`. A core that is not
//! running simply refuses the socket, which the page reports as-is — there is
//! nothing to cache and nothing to fall back to.

use serde::Serialize;
use serde_json::Value;

use crate::api::{authorized, client, offline, text};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub host: String,
    pub network: String,
    /// `metadata.type` — HTTP, SOCKS5, TUN, …
    pub kind: String,
    pub source: String,
    pub destination: String,
    pub upload: u64,
    pub download: u64,
    pub start: String,
    /// Proxy chain, outermost group first.
    pub chains: Vec<String>,
    pub rule: String,
    pub rule_payload: String,
    pub process: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsView {
    pub upload_total: u64,
    pub download_total: u64,
    pub connections: Vec<Connection>,
}

pub async fn list() -> Result<ConnectionsView, String> {
    let (client, base, secret) = client()?;
    let response = authorized(client.get(format!("{base}/connections")), secret.as_deref())
        .send()
        .await
        .map_err(offline)?;
    if !response.status().is_success() {
        return Err(format!(
            "The core refused the request: HTTP {}",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Cannot read the connection list: {e}"))?;
    Ok(parse(&value))
}

pub async fn close(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') {
        return Err("Invalid connection id".to_string());
    }
    let (client, base, secret) = client()?;
    let response = authorized(
        client.delete(format!("{base}/connections/{id}")),
        secret.as_deref(),
    )
    .send()
    .await
    .map_err(offline)?;
    if response.status().is_success() || response.status().as_u16() == 404 {
        Ok(())
    } else {
        Err(format!(
            "The core refused the request: HTTP {}",
            response.status()
        ))
    }
}

pub async fn close_all() -> Result<(), String> {
    let (client, base, secret) = client()?;
    let response = authorized(client.delete(format!("{base}/connections")), secret.as_deref())
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

fn parse(value: &Value) -> ConnectionsView {
    let connections = value
        .get("connections")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(entry).collect())
        .unwrap_or_default();
    ConnectionsView {
        upload_total: number(value.get("uploadTotal")),
        download_total: number(value.get("downloadTotal")),
        connections,
    }
}

fn entry(value: &Value) -> Connection {
    let metadata = value.get("metadata");
    let chains = value
        .get("chains")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Connection {
        id: text(value.get("id")),
        host: text(metadata.and_then(|m| m.get("host"))),
        network: text(metadata.and_then(|m| m.get("network"))),
        kind: text(metadata.and_then(|m| m.get("type"))),
        source: address(metadata, "sourceIP", "sourcePort"),
        destination: address(metadata, "destinationIP", "destinationPort"),
        upload: number(value.get("upload")),
        download: number(value.get("download")),
        start: text(value.get("start")),
        chains,
        rule: text(value.get("rule")),
        rule_payload: text(value.get("rulePayload")),
        process: text(metadata.and_then(|m| m.get("processPath"))),
    }
}

fn number(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn address(metadata: Option<&Value>, host: &str, port: &str) -> String {
    let Some(metadata) = metadata else {
        return String::new();
    };
    let host = text(metadata.get(host));
    let port = text(metadata.get(port));
    match (host.is_empty(), port.is_empty()) {
        (true, _) => String::new(),
        (false, true) => host,
        (false, false) => format!("{host}:{port}"),
    }
}
