//! The exit IP as seen from the running core.
//!
//! The home page's IP card is only meaningful when the request leaves through
//! the proxy, so the lookup goes through the core's mixed port whenever one is
//! answering. With no core the same request runs direct and shows the machine's
//! own address, which is what the card should say in that state.
//!
//! Three free lookup services are tried in order; each returns the same facts
//! under different names, so every response is mapped onto one shape here.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::runtime;

const SERVICES: [&str; 3] = [
    "https://api.ip.sb/geoip",
    "https://ipapi.co/json",
    "https://get.geojs.io/v1/ip/geo.json",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpInfo {
    pub ip: String,
    pub country: String,
    pub country_code: String,
    pub region: String,
    pub city: String,
    /// The network the address belongs to, as the service names it.
    pub organization: String,
    pub asn: Option<u64>,
    pub asn_organization: String,
    pub longitude: Option<f64>,
    pub latitude: Option<f64>,
    pub timezone: String,
}

pub async fn fetch() -> Result<IpInfo, String> {
    let client = client().await?;
    let mut last = String::from("no service answered");

    for url in SERVICES {
        match lookup(&client, url).await {
            Ok(info) => return Ok(info),
            Err(error) => last = error,
        }
    }
    Err(format!("Cannot read the exit IP: {last}"))
}

async fn client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("WingHarness");

    if let Some(port) = proxy_port().await {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
            .map_err(|e| format!("Cannot use the core's proxy: {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

/// The port that carries both HTTP and SOCKS traffic, if a core answers.
async fn proxy_port() -> Option<u16> {
    runtime::view()
        .await
        .ok()
        .and_then(|view| view.mixed_port.or(view.http_port))
}

async fn lookup(client: &reqwest::Client, url: &str) -> Result<IpInfo, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status()));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    parse(url, &value).ok_or_else(|| format!("{url}: response has no IP"))
}

fn parse(url: &str, value: &Value) -> Option<IpInfo> {
    let ip = text(value, &["ip"]);
    if ip.is_empty() {
        return None;
    }

    let mut info = IpInfo {
        ip,
        country: text(value, &["country"]),
        country_code: text(value, &["country_code"]),
        region: text(value, &["region"]),
        city: text(value, &["city"]),
        organization: String::new(),
        asn: asn(value.get("asn")),
        asn_organization: String::new(),
        longitude: number(value, &["longitude"]),
        latitude: number(value, &["latitude"]),
        timezone: text(value, &["timezone"]),
    };

    if url.contains("ipapi.co") {
        info.country = text(value, &["country_name"]);
        info.organization = text(value, &["org"]);
        info.asn_organization = info.organization.clone();
    } else if url.contains("geojs.io") {
        info.organization = text(value, &["organization_name"]);
        info.asn_organization = info.organization.clone();
    } else {
        info.organization = text(value, &["organization"]);
        info.asn_organization = text(value, &["asn_organization"]);
        if info.asn_organization.is_empty() {
            info.asn_organization = info.organization.clone();
        }
    }

    Some(info)
}

fn text(value: &Value, path: &[&str]) -> String {
    at(value, path)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn number(value: &Value, path: &[&str]) -> Option<f64> {
    at(value, path).and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
    })
}

fn asn(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_str()
            .map(|text| text.trim().trim_start_matches("AS"))
            .and_then(|text| text.parse().ok())
    })
}

fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |current, key| current.get(*key))
}
