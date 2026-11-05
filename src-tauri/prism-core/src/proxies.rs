//! Proxy groups and the node each one routes through.
//!
//! mihomo answers `/proxies` with its whole routing table: every group, the
//! members it may pick from, and the delay each one last recorded. Picking a
//! member is a `PUT` on the group's own name — only `Selector` groups accept
//! it, the rest choose for themselves.

use reqwest::Url;
use serde::Serialize;
use serde_json::Value;

use crate::api::{authorized, client, offline, text};

/// What mihomo itself fetches when it probes a node: a tiny body, no redirects.
const PROBE_URL: &str = "http://www.gstatic.com/generate_204";
const PROBE_TIMEOUT_MS: &str = "5000";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNode {
    pub name: String,
    /// `Shadowsocks`, `Vmess`, `Selector`, … — the member may itself be a group.
    pub kind: String,
    pub alive: bool,
    /// Last delay in milliseconds; absent until the node has been probed.
    pub delay: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyGroup {
    pub name: String,
    /// `Selector`, `URLTest`, `Fallback`, `LoadBalance`, …
    pub kind: String,
    /// The member traffic currently leaves through; empty for automatic groups
    /// that have not picked yet.
    pub now: String,
    pub members: Vec<ProxyNode>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxiesView {
    pub groups: Vec<ProxyGroup>,
}

pub async fn list() -> Result<ProxiesView, String> {
    let (client, base, secret) = client()?;
    let response = authorized(client.get(format!("{base}/proxies")), secret.as_deref())
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
        .map_err(|e| format!("Cannot read the proxy list: {e}"))?;
    Ok(parse(&value))
}

/// Route `group` through `name`. Group names are user text — spaces, punctuation
/// and CJK are all normal — so the path segment is encoded rather than pasted.
pub async fn select(group: &str, name: &str) -> Result<(), String> {
    if group.is_empty() || name.is_empty() {
        return Err("A group and a member are required".to_string());
    }

    let (client, base, secret) = client()?;
    let mut url = Url::parse(&format!("{base}/proxies/"))
        .map_err(|e| format!("Invalid controller address: {e}"))?;
    url.path_segments_mut()
        .map_err(|_| "Invalid controller address".to_string())?
        .pop_if_empty()
        .push(group);

    let response = authorized(
        client.put(url).json(&serde_json::json!({ "name": name })),
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

/// Probe one node on demand. The core performs the request itself, so the
/// number is what that proxy can actually reach, not a ping from this process.
pub async fn delay_test(name: &str) -> Result<u32, String> {
    if name.is_empty() {
        return Err("A node name is required".to_string());
    }

    let (client, base, secret) = client()?;
    let mut url = Url::parse(&format!("{base}/proxies/"))
        .map_err(|e| format!("Invalid controller address: {e}"))?;
    url.path_segments_mut()
        .map_err(|_| "Invalid controller address".to_string())?
        .pop_if_empty()
        .push(name)
        .push("delay");
    url.query_pairs_mut()
        .append_pair("timeout", PROBE_TIMEOUT_MS)
        .append_pair("url", PROBE_URL);

    let response = authorized(client.get(url), secret.as_deref())
        .send()
        .await
        .map_err(offline)?;
    if !response.status().is_success() {
        // A timeout is the normal answer for a dead node; the status alone says
        // nothing useful beyond that it did not come back in time.
        return Err(format!(
            "The node did not answer within the timeout (HTTP {})",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Cannot read the probe result: {e}"))?;
    value
        .get("delay")
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
        .map(|ms| ms.min(u32::MAX as u64) as u32)
        .ok_or_else(|| "The core reported no delay".to_string())
}

fn parse(value: &Value) -> ProxiesView {
    let Some(table) = value.get("proxies").and_then(Value::as_object) else {
        return ProxiesView::default();
    };

    let mut groups: Vec<ProxyGroup> = table
        .iter()
        .filter_map(|(name, entry)| group(name, entry, table))
        .collect();
    // The core returns a map, so the order is arbitrary. GLOBAL lists every node
    // there is, so it goes last; the groups the profile defines lead, sorted by
    // name so the list stays stable between polls.
    groups.sort_by(|a, b| {
        (a.name == "GLOBAL")
            .cmp(&(b.name == "GLOBAL"))
            .then_with(|| a.name.cmp(&b.name))
    });

    ProxiesView { groups }
}

/// A group is anything carrying a non-empty member list. Standalone proxies have
/// no list of their own; they only show up as members.
fn group(name: &str, entry: &Value, table: &serde_json::Map<String, Value>) -> Option<ProxyGroup> {
    let members = entry.get("all")?.as_array()?;
    if members.is_empty() {
        return None;
    }
    Some(ProxyGroup {
        name: name.to_string(),
        kind: text(entry.get("type")),
        now: text(entry.get("now")),
        members: members
            .iter()
            .filter_map(Value::as_str)
            .map(|member| node(member, table.get(member)))
            .collect(),
    })
}

fn node(name: &str, entry: Option<&Value>) -> ProxyNode {
    match entry {
        Some(entry) => ProxyNode {
            name: name.to_string(),
            kind: text(entry.get("type")),
            alive: entry.get("alive").and_then(Value::as_bool).unwrap_or(true),
            delay: delay(entry),
        },
        None => ProxyNode {
            name: name.to_string(),
            kind: String::new(),
            alive: true,
            delay: None,
        },
    }
}

/// `history` is the probe log; the last entry is the most recent result. A
/// timeout is recorded as delay 0, which is not a number worth showing.
fn delay(entry: &Value) -> Option<u32> {
    entry
        .get("history")
        .and_then(Value::as_array)
        .and_then(|probes| probes.last())
        .and_then(|probe| probe.get("delay"))
        .and_then(Value::as_u64)
        .filter(|ms| *ms > 0)
        .map(|ms| ms.min(u32::MAX as u64) as u32)
}
