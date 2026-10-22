//! The fonts a theme asks for, fetched on demand and kept on disk.
//!
//! tweakcn's themes name their own typefaces (`DM Sans`, `Space Mono`, …), and
//! the app ships with none of them: the stacks end in a generic family, so a
//! missing font quietly renders as whatever the system picks. This module makes
//! the ones a theme actually uses available, downloading them the first time
//! that theme is selected and reading them from disk every time after.
//!
//! Layout: one directory per family under `<data dir>/.theme-fonts`, holding the
//! `.woff2` files it was built from and the `font-face.css` the frontend gets
//! back. That CSS carries the font bytes as data URLs, which is what keeps the
//! frontend from needing file access or an asset-protocol scope — and it is also
//! the cache's hit marker: if it is there, nothing is downloaded again.
//!
//! Nothing here is fatal. A family that cannot be fetched is simply missing from
//! the CSS, and the theme's fallback stack takes over.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use tauri::async_runtime::spawn_blocking;

/// Weights fetched for every family. Themes style body text and headings with
/// the same family, so the usual shadcn weight range is what is needed; a weight
/// the family does not offer is skipped.
const WEIGHTS: [u16; 4] = [400, 500, 600, 700];

/// One family's stylesheet, when the request is not going to arrive at all.
const REQUEST_TIMEOUT_SECS: u64 = 20;

/// Google only serves woff2 — and only splits the response into per-subset
/// `@font-face` blocks — to clients that look like a browser.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// The subset covering what this app displays. Google emits one block per subset
/// per weight, and picking this one is what keeps a latin-only UI from paying
/// for cyrillic and greek.
const LATIN_RANGE_MARKER: &str = "U+0000-00FF";

/// Ceiling on one call, so a bogus request cannot turn into a download storm.
const MAX_FAMILIES: usize = 16;

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// The feature's own directory, under the data directory so the whole thing
/// stays movable between machines.
fn root() -> PathBuf {
    crate::config::dir().join(".theme-fonts")
}

/// A family name reduced to something safe to use as a directory name and as a
/// Fontsource package name.
fn slug(family: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in family.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    slug
}

/// Family names reach here from a webview, so reject anything that is not a
/// plain typeface name before it is put into a URL or a path.
fn is_plausible_family(family: &str) -> bool {
    !family.is_empty()
        && family.len() <= 64
        && family
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '\'' | '.' | '&'))
}

/// Whether the system already has this family, which makes downloading it moot.
fn is_installed(family: &str) -> bool {
    font_kit::source::SystemSource::new()
        .select_family_by_name(family)
        .is_ok()
}

/// Every `font-weight` → woff2 URL pair in a Google Fonts stylesheet, latin
/// subset preferred. A weight with no latin block (some families have none)
/// keeps whichever subset came first, which is better than nothing.
fn parse_google_css(css: &str) -> BTreeMap<u16, String> {
    let mut faces: BTreeMap<u16, String> = BTreeMap::new();
    let mut latin: BTreeMap<u16, String> = BTreeMap::new();

    for block in css.split("@font-face").skip(1) {
        let Some(weight) = block
            .split("font-weight:")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .and_then(|value| value.trim().parse::<u16>().ok())
        else {
            continue;
        };
        let Some(url) = block
            .split("url(")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .map(|url| url.trim().trim_matches(['\'', '"']).to_string())
        else {
            continue;
        };

        if block.contains(LATIN_RANGE_MARKER) {
            latin.insert(weight, url);
        } else {
            faces.entry(weight).or_insert(url);
        }
    }

    for (weight, url) in latin {
        faces.insert(weight, url);
    }
    faces
}

/// Save one family's files and return the `@font-face` rules that read them.
///
/// Writes nothing unless at least one weight came down, so a family that failed
/// is retried the next time its theme is selected rather than being remembered
/// as unavailable.
fn download_family(client: &reqwest::blocking::Client, family: &str) -> Result<String, String> {
    let slug = slug(family);
    if slug.is_empty() {
        return Err(format!("no usable name in font family {family:?}"));
    }
    let dir = root().join(&slug);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {dir:?}: {e}"))?;

    let sources = google_css(client, family).unwrap_or_default();
    let mut written: Vec<(u16, PathBuf)> = Vec::new();

    for weight in WEIGHTS {
        let bytes = match sources.get(&weight) {
            Some(url) => fetch_bytes(client, url),
            // Google composes its URLs per request, so a family it does not
            // serve (or does not serve at this weight) has to come from
            // Fontsource's fixed per-weight file names instead.
            None => fetch_bytes(client, &fontsource_url(&slug, weight)),
        };
        let Ok(bytes) = bytes else { continue };

        let file = dir.join(format!("{slug}-{weight}.woff2"));
        fs::write(&file, &bytes).map_err(|e| format!("Failed to write {file:?}: {e}"))?;
        written.push((weight, file));
    }

    if written.is_empty() {
        return Err(format!("no weights available for {family:?}"));
    }

    let mut css = String::new();
    for (weight, file) in written {
        let bytes = fs::read(&file).map_err(|e| format!("Failed to read {file:?}: {e}"))?;
        css.push_str(&font_face_rule(family, weight, &STANDARD.encode(bytes)));
    }

    let sheet = dir.join("font-face.css");
    fs::write(&sheet, &css).map_err(|e| format!("Failed to write {sheet:?}: {e}"))?;
    Ok(css)
}

/// The Google Fonts stylesheet for one family, which is what assigns each weight
/// a woff2 URL.
fn google_css(
    client: &reqwest::blocking::Client,
    family: &str,
) -> Result<BTreeMap<u16, String>, String> {
    let weights = WEIGHTS.map(|w| w.to_string()).join(";");
    let url = format!(
        "https://fonts.googleapis.com/css2?family={}:wght@{}&display=swap",
        family.replace(' ', "+"),
        weights
    );
    let css = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("Google Fonts request failed for {family:?}: {e}"))?;
    Ok(parse_google_css(&css))
}

/// Fontsource's file naming, which is stable and needs no stylesheet to resolve.
fn fontsource_url(slug: &str, weight: u16) -> String {
    format!(
        "https://cdn.jsdelivr.net/npm/@fontsource/{slug}/files/{slug}-latin-{weight}-normal.woff2"
    )
}

fn fetch_bytes(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("Font download failed from {url}: {e}"))
}

fn font_face_rule(family: &str, weight: u16, base64: &str) -> String {
    format!(
        "@font-face{{font-family:\"{family}\";font-style:normal;font-weight:{weight};\
         font-display:swap;src:url(data:font/woff2;base64,{base64}) format(\"woff2\");}}\n"
    )
}

/// One family's rules, from the cache when it has them.
fn family_css(client: &reqwest::blocking::Client, family: &str) -> String {
    let sheet = root().join(slug(family)).join("font-face.css");
    if let Ok(css) = fs::read_to_string(&sheet) {
        return css;
    }

    // A font the system already has needs no download, and no rules either —
    // the theme's stack reaches it by name. Recording that as an empty sheet
    // keeps the check to one file read next time.
    if is_installed(family) {
        if let Some(parent) = sheet.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&sheet, "");
        return String::new();
    }

    match download_family(client, family) {
        Ok(css) => css,
        Err(error) => {
            eprintln!("theme fonts: {error}");
            String::new()
        }
    }
}

/// `@font-face` rules for the fonts of the theme in use.
///
/// Never fails: families that cannot be fetched are left out, and the app falls
/// back to the fonts in the theme's own `font-*` stacks.
pub async fn font_css(families: Vec<String>) -> Result<String, String> {
    let wanted: Vec<String> = families
        .into_iter()
        .filter(|family| is_plausible_family(family))
        .take(MAX_FAMILIES)
        .collect();
    if wanted.is_empty() {
        return Ok(String::new());
    }

    spawn_blocking(move || {
        // One client for the whole call: the families of a theme are fetched
        // together, and a client per family would pay for the TLS setup each.
        let Ok(client) = client() else {
            return String::new();
        };
        wanted
            .iter()
            .map(|family| family_css(&client, family))
            .collect()
    })
    .await
    .map_err(|e| format!("Font task failed: {e}"))
}
