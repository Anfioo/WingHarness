//! Reachability checks for the sites the user cares about.
//!
//! A check fetches one URL through the running core's own HTTP proxy port, so
//! the answer covers the whole path real traffic takes: the selected node, its
//! outbound, and the DNS the core resolved. The list of sites is kept in
//! `clash/tests.json`; the defaults are only proposed until the user edits.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::runtime;
use crate::store;

/// A site the page can check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSite {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    /// Milliseconds from sending the request to reading the response headers.
    pub delay: u32,
    /// HTTP status the site answered with.
    pub status: u16,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Book {
    items: Vec<TestSite>,
}

/// A node that cannot reach a site will not start doing so after ten seconds.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Some sites refuse clients that do not look like a browser. This check is
/// about reachability, so it identifies as one.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
    (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Sites a fresh install checks: one per common blocker, so a broken exit shows
/// up as a pattern rather than as a single site's outage.
pub fn defaults() -> Vec<TestSite> {
    [
        ("apple", "Apple", "https://www.apple.com"),
        ("github", "GitHub", "https://www.github.com"),
        ("google", "Google", "https://www.google.com"),
        ("youtube", "YouTube", "https://www.youtube.com"),
    ]
    .into_iter()
    .map(|(id, name, url)| TestSite {
        id: id.to_string(),
        name: name.to_string(),
        url: url.to_string(),
    })
    .collect()
}

/// The saved list, or the defaults while nothing has been saved. An existing
/// empty file means the user removed every site; that is not the same as a file
/// that was never written.
pub fn list() -> Result<Vec<TestSite>, String> {
    let Ok(text) = std::fs::read_to_string(store::test_sites_path()?) else {
        return Ok(defaults());
    };
    let book: Book = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to read test sites: {e}"))?;
    Ok(book.items)
}

pub fn save(sites: Vec<TestSite>) -> Result<(), String> {
    let items = validate(sites)?;
    let text = serde_json::to_string_pretty(&Book { items })
        .map_err(|e| format!("Failed to serialize test sites: {e}"))?;
    store::atomic_write(&store::test_sites_path()?, &text)
}

/// Fetch `url` through the core. A rejection means the site could not be
/// reached; an HTTP error status is still an answer and comes back as a result.
pub async fn probe(url: &str) -> Result<TestResult, String> {
    let target = normalize_url(url)?;
    // The running core says which port to use: whatever the user last applied
    // is what the check has to go through.
    let view = runtime::view().await?;
    let port = view.http_port.ok_or_else(|| {
        "The core is not listening on an HTTP port; set mixed-port or port in the profile"
            .to_string()
    })?;

    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|e| format!("Cannot use the core as a proxy: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        // The environment's own proxy settings must not take over: this check
        // is about the core, not about what Windows is pointed at.
        .no_proxy()
        .proxy(proxy)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let started = Instant::now();
    let response = client
        .get(&target)
        .send()
        .await
        .map_err(failure)?;
    let delay = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
    Ok(TestResult {
        delay: delay.max(1),
        status: response.status().as_u16(),
    })
}

fn failure(error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("No answer within {} seconds", TIMEOUT.as_secs())
    } else if error.is_connect() {
        format!("Cannot connect to the site: {error}")
    } else {
        format!("Request failed: {error}")
    }
}

fn validate(sites: Vec<TestSite>) -> Result<Vec<TestSite>, String> {
    const MAX_SITES: usize = 100;

    if sites.len() > MAX_SITES {
        return Err(format!("Too many test sites (at most {MAX_SITES})"));
    }

    let mut seen = HashSet::new();
    sites
        .into_iter()
        .map(|site| {
            let id = site.id.trim();
            let name = site.name.trim();
            let url = normalize_url(&site.url)?;
            if id.is_empty() {
                return Err("A test site is missing its identifier".to_string());
            }
            if name.is_empty() {
                return Err("A test site needs a name".to_string());
            }
            if name.chars().count() > 64 {
                return Err(format!("Test site name is too long: {name}"));
            }
            if !seen.insert(id.to_string()) {
                return Err(format!("Duplicate test site identifier: {id}"));
            }
            Ok(TestSite {
                id: id.to_string(),
                name: name.to_string(),
                url,
            })
        })
        .collect()
}

fn normalize_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("A test site needs a URL".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https URLs can be tested".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("The URL has no host".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_valid_sites() {
        let sites = defaults();
        assert_eq!(sites.len(), 4);
        let checked = validate(sites).unwrap();
        assert!(checked.iter().all(|site| site.url.starts_with("https://")));
    }

    #[test]
    fn only_http_urls_are_accepted() {
        assert!(normalize_url("https://example.com").is_ok());
        assert!(normalize_url(" http://example.com/path ").is_ok());
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("example.com").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn blank_names_and_duplicate_ids_are_rejected() {
        let site = |id: &str, name: &str| TestSite {
            id: id.to_string(),
            name: name.to_string(),
            url: "https://example.com".to_string(),
        };
        assert!(validate(vec![site("a", "")]).is_err());
        assert!(validate(vec![site("a", "A"), site("a", "B")]).is_err());
        assert!(validate(vec![site("a", "A"), site("b", "B")]).is_ok());
    }
}
