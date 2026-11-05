//! URL subscriptions.
//!
//! A subscription is a link plus the profile its download lands in. The body is
//! written straight into `profiles/<name>.yaml`, so the compiler never learns
//! where a profile came from — subscription output and hand-written configs are
//! the same thing to it.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::profiles;
use crate::store;

/// A provider sends a config; anything bigger than this is not one.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Several providers pick their Clash output by client name.
const USER_AGENT: &str = "clash.meta";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Subscription {
    pub name: String,
    pub url: String,
    /// The profile this subscription writes, e.g. `airport.yaml`.
    pub profile: String,
    /// Unix seconds of the last successful download.
    pub last_updated: Option<i64>,
    pub size: u64,
    pub upload: u64,
    pub download: u64,
    pub total: u64,
    /// Unix seconds the provider says the plan runs out.
    pub expire: Option<i64>,
    /// Why the last download failed; cleared by the next success.
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Book {
    items: Vec<Subscription>,
}

pub fn list() -> Result<Vec<Subscription>, String> {
    Ok(load()?.items)
}

/// Register a link. Nothing is fetched here: the caller runs [`update`] so it
/// can show the download separately from the save.
pub fn add(name: &str, url: &str) -> Result<Subscription, String> {
    let name = name.trim();
    let url = normalize_url(url)?;
    let profile = profile_id(name)?;

    let mut book = load()?;
    if book.items.iter().any(|item| item.name == name) {
        return Err(format!("Subscription {name} already exists"));
    }
    let claimed = book.items.iter().any(|item| item.profile == profile);
    if !claimed && store::profiles_dir()?.join(&profile).exists() {
        return Err(format!(
            "A profile named {name} already exists; pick another name"
        ));
    }

    let entry = Subscription {
        name: name.to_string(),
        url,
        profile,
        ..Subscription::default()
    };
    book.items.push(entry.clone());
    save(&book)?;
    Ok(entry)
}

/// Drop the link and the config it downloaded. The profile is ours to remove:
/// the user did not write it, every successful update overwrote it.
pub fn remove(name: &str) -> Result<(), String> {
    let mut book = load()?;
    let Some(index) = book.items.iter().position(|item| item.name == name) else {
        return Err(format!("Subscription {name} does not exist"));
    };
    let entry = book.items.remove(index);
    save(&book)?;
    // Refuses to remove the last profile; the record is gone either way.
    let _ = profiles::delete(&entry.profile);
    Ok(())
}

/// Download the link and replace its profile with what came back.
///
/// A failure is recorded on the entry before it is returned, so the list keeps
/// saying why a provider stopped updating after the toast is gone.
pub async fn update(name: &str) -> Result<Subscription, String> {
    let mut book = load()?;
    let index = book
        .items
        .iter()
        .position(|item| item.name == name)
        .ok_or_else(|| format!("Subscription {name} does not exist"))?;

    let fetched = fetch(&book.items[index].url).await;

    let entry = &mut book.items[index];
    let Fetched {
        body,
        upload,
        download,
        total,
        expire,
    } = match fetched {
        Ok(fetched) => fetched,
        Err(error) => {
            entry.error = Some(error.clone());
            save(&book)?;
            return Err(error);
        }
    };

    // Write first: a profile that cannot be written is not an update, and the
    // entry keeps saying so.
    if let Err(error) = profiles::write(&entry.profile, &body) {
        entry.error = Some(error.clone());
        save(&book)?;
        return Err(error);
    }

    entry.size = body.len() as u64;
    entry.upload = upload;
    entry.download = download;
    entry.total = total;
    entry.expire = expire;
    entry.last_updated = Some(now());
    entry.error = None;
    let result = entry.clone();
    save(&book)?;
    Ok(result)
}

struct Fetched {
    body: String,
    upload: u64,
    download: u64,
    total: u64,
    expire: Option<i64>,
}

async fn fetch(url: &str) -> Result<Fetched, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Download failed: HTTP {status}"));
    }
    if let Some(length) = response.content_length() {
        if length > MAX_BYTES {
            return Err(format!("Response is too large ({length} bytes)"));
        }
    }

    let (upload, download, total, expire) = response
        .headers()
        .get("subscription-userinfo")
        .and_then(|value| value.to_str().ok())
        .map(parse_userinfo)
        .unwrap_or_default();

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("Response is too large ({} bytes)", bytes.len()));
    }
    let body =
        String::from_utf8(bytes.to_vec()).map_err(|_| "The response is not UTF-8 text".to_string())?;
    check_config(&body)?;

    Ok(Fetched {
        body,
        upload,
        download,
        total,
        expire,
    })
}

/// Reject whatever a provider sends when the link is wrong: an HTML error page
/// parses as neither YAML nor anything with proxies in it.
fn check_config(body: &str) -> Result<(), String> {
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(body)
        .map_err(|e| format!("The response is not a valid Clash config: {e}"))?;
    let has_proxies = value
        .as_mapping()
        .map(|map| {
            map.get(serde_yaml_ng::Value::String("proxies".into()))
                .is_some_and(serde_yaml_ng::Value::is_sequence)
        })
        .unwrap_or(false);
    if has_proxies {
        Ok(())
    } else {
        Err("The response has no proxies list; check the subscription link".to_string())
    }
}

/// `upload=1; download=2; total=3; expire=4`, as providers send it.
fn parse_userinfo(header: &str) -> (u64, u64, u64, Option<i64>) {
    let (mut upload, mut download, mut total, mut expire) = (0, 0, 0, None);
    for part in header.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "upload" => upload = value.parse().unwrap_or(0),
            "download" => download = value.parse().unwrap_or(0),
            "total" => total = value.parse().unwrap_or(0),
            "expire" => expire = value.parse::<i64>().ok().filter(|seconds| *seconds > 0),
            _ => {}
        }
    }
    (upload, download, total, expire)
}

fn normalize_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("The subscription link must not be empty".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid link: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https links are supported".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("The link has no host".to_string());
    }
    Ok(trimmed.to_string())
}

fn profile_id(name: &str) -> Result<String, String> {
    Ok(format!("{}.yaml", store::sanitize_name(name)?))
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn load() -> Result<Book, String> {
    let Ok(text) = std::fs::read_to_string(store::subscriptions_path()?) else {
        return Ok(Book::default());
    };
    serde_json::from_str(&text).map_err(|e| format!("Failed to read subscriptions: {e}"))
}

fn save(book: &Book) -> Result<(), String> {
    let text = serde_json::to_string_pretty(book)
        .map_err(|e| format!("Failed to serialize subscriptions: {e}"))?;
    store::atomic_write(&store::subscriptions_path()?, &text)
}
