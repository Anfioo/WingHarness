//! The routing rules the running core is applying.
//!
//! mihomo answers `/rules` with its compiled rule set in evaluation order: the
//! first rule that matches decides where the request goes. That list is what the
//! config actually produced, not what the patch files say, so it is worth showing
//! as-is.

use serde::Serialize;
use serde_json::Value;

use crate::api::{authorized, client, offline, text};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRule {
    /// `DomainSuffix`, `GeoIP`, `Match`, …; empty for types this core predates.
    pub kind: String,
    /// The value the rule matches — a domain, an IP, a port. Empty for `MATCH`.
    pub payload: String,
    /// The group or node the request is handed to.
    pub proxy: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRulesView {
    pub rules: Vec<RoutingRule>,
}

pub async fn list() -> Result<RoutingRulesView, String> {
    let (client, base, secret) = client()?;
    let response = authorized(client.get(format!("{base}/rules")), secret.as_deref())
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
        .map_err(|e| format!("Cannot read the rule list: {e}"))?;
    Ok(parse(&value))
}

fn parse(value: &Value) -> RoutingRulesView {
    let rules = value
        .get("rules")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(rule).collect())
        .unwrap_or_default();
    RoutingRulesView { rules }
}

fn rule(value: &Value) -> RoutingRule {
    RoutingRule {
        kind: kind(value.get("type")),
        payload: text(value.get("payload")),
        proxy: text(value.get("proxy")),
    }
}

/// A rule type is normally a string. A type the core does not know is sent as a
/// one-key object (`{ "Unknown": "..." }`), which is still worth naming.
fn kind(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(kind)) => kind.clone(),
        Some(Value::Object(map)) => map.keys().next().cloned().unwrap_or_default(),
        _ => String::new(),
    }
}
