//! The `codeg-server` distribution the app installs for itself.
//!
//! Production Codeg has no checkout to point at. Every release of the fork
//! attaches `codeg-server-web-<tag>-windows-x64.zip` — the `codeg-server`
//! executable with the `web/` export beside it — and a fixed `server.json`
//! saying where that archive is, what its checksum is and how big it is. The app
//! downloads the archive, verifies it against that manifest and unpacks it here:
//!
//! ```text
//! <data dir>/codeg-server/
//!   codeg-server.exe
//!   web/
//!   install.json     what was installed, and from where
//! ```
//!
//! The split of work is the runtime installer's (see
//! [`crate::commands::runtime`]): the archive travels through the moin engine,
//! is unpacked by 7z-wasm in a worker, and Rust only verifies the bytes it is
//! handed and writes the entries that came back. Verification lives here rather
//! than in the page because the checksum is the only thing standing between a
//! truncated download and a half-broken install.
//!
//! Neither directory is user-configurable: the paths follow the data directory,
//! so moving the data directory moves the install with it, and the settings page
//! shows them read-only.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::AppHandle;

use crate::codeg::server;
use crate::config;

/// Folder under the data directory holding the unpacked archive.
const INSTALL_DIR: &str = "codeg-server";
/// The export inside that folder, beside the executable.
const WEB_DIR: &str = "web";
/// The executable inside that folder.
#[cfg(windows)]
const BINARY: &str = "codeg-server.exe";
#[cfg(not(windows))]
const BINARY: &str = "codeg-server";
/// What was installed, recorded beside it.
const RECORD_FILE: &str = "install.json";
/// Largest archive the reader will accept, matching the runtime installer.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
/// Longest relative path an unpacked entry may have.
const MAX_RELATIVE_PATH: usize = 512;

/// Where the release manifest is published, in the order it is tried.
///
/// GitHub is the source of truth: `server.json` has a fixed name on the latest
/// release, so this URL never changes. The Cloudflare R2 mirror publishes the
/// same manifest under its own fixed `latest/` key, with the archive URL
/// repointed at the mirror, so either endpoint installs identical bytes and a
/// failing GitHub degrades to the mirror.
pub const ENDPOINTS: &[&str] = &[
    "https://github.com/Anfioo/codeg/releases/latest/download/server.json",
    "https://wingharness.dpdns.org/WhCodeg/latest/server.json",
];

/// The three paths the install owns, all derived from the data directory.
pub struct Paths {
    pub dir: PathBuf,
    pub static_dir: PathBuf,
    pub server_path: PathBuf,
}

/// Where the install lives right now.
pub fn paths() -> Paths {
    let dir = config::dir().join(INSTALL_DIR);
    Paths {
        static_dir: dir.join(WEB_DIR),
        server_path: dir.join(BINARY),
        dir,
    }
}

/// What the settings page shows about the install.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallView {
    pub dir: String,
    pub static_dir: String,
    pub server_path: String,
    /// Both halves are there: a binary without its export is not an install.
    pub installed: bool,
    /// The version the record names, when there is a record.
    pub version: Option<String>,
    pub tag: Option<String>,
}

/// The local record: the manifest fields that identify the installed build.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub version: String,
    pub tag: String,
    pub sha256: String,
    pub size: u64,
    /// Which mirror served it, as a short label.
    pub endpoint: String,
    /// The archive URL that was downloaded.
    pub url: String,
    /// Unix seconds, so the page can say when it was installed.
    pub installed_at: u64,
}

/// One published archive, as the release's `server.json` describes it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseView {
    /// Short label of the mirror that answered (`GitHub`, `Cloudflare`).
    pub endpoint: String,
    pub version: String,
    pub tag: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// The version already installed, when one is.
    pub installed_version: Option<String>,
    /// The manifest names a newer version than the installed one.
    pub update_available: bool,
}

/// The install as it stands, for `codeg_state`.
pub fn view() -> InstallView {
    let paths = paths();
    let record = read_record();
    InstallView {
        dir: paths.dir.to_string_lossy().to_string(),
        static_dir: paths.static_dir.to_string_lossy().to_string(),
        server_path: paths.server_path.to_string_lossy().to_string(),
        installed: paths.server_path.is_file() && paths.static_dir.is_dir(),
        version: record.as_ref().map(|record| record.version.clone()),
        tag: record.map(|record| record.tag),
    }
}

/// The local record, or `None` when there is none to read.
///
/// A record that cannot be parsed is treated as absent: the executable and the
/// export decide whether the install exists, the record only names it.
fn read_record() -> Option<InstallRecord> {
    let path = paths().dir.join(RECORD_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Asks the manifests what the newest published build is.
///
/// The endpoints are tried in order, so a failing GitHub degrades to the mirror
/// instead of failing the check outright.
pub async fn release() -> Result<ReleaseView, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to build the Codeg HTTP client: {error}"))?;

    let mut last_error: Option<String> = None;
    for href in ENDPOINTS {
        match fetch_manifest(&client, href).await {
            Ok(view) => return Ok(view),
            Err(error) => last_error = Some(format!("{}: {error}", endpoint_label(href))),
        }
    }

    Err(last_error.unwrap_or_else(|| "No Codeg release endpoint is configured.".to_string()))
}

/// Reads and checks one `server.json`.
async fn fetch_manifest(client: &reqwest::Client, href: &str) -> Result<ReleaseView, String> {
    let response = client
        .get(href)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let manifest: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("The release manifest is not JSON: {error}"))?;

    let version = manifest
        .get("version")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "The release manifest has no version.".to_string())?
        .to_string();
    let tag = manifest
        .get("tag")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();

    let target = target_key().ok_or_else(|| "This platform has no Codeg build.".to_string())?;
    let platform = manifest
        .get("platforms")
        .and_then(|value| value.get(target))
        .ok_or_else(|| format!("The release manifest has no entry for {target}."))?;

    let url = platform
        .get("url")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "The release manifest has no download URL.".to_string())?
        .to_string();
    let sha256 = platform
        .get("sha256")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "The release manifest has no checksum.".to_string())?
        .to_string();
    let size = platform
        .get("size")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "The release manifest has no archive size.".to_string())?;

    let installed_version = read_record().map(|record| record.version);
    let update_available = match installed_version.as_deref() {
        None => true,
        Some(current) => match (Version::parse(current), Version::parse(&version)) {
            // A manifest and a record this app wrote are both semver in
            // practice, but a hand-edited one need not be: fall back to "it
            // changed" rather than refusing to update.
            (Ok(current), Ok(remote)) => remote > current,
            _ => current != version,
        },
    };

    Ok(ReleaseView {
        endpoint: endpoint_label(href).to_string(),
        version,
        tag,
        url,
        sha256,
        size,
        installed_version,
        update_available,
    })
}

/// A short name for the mirror behind an endpoint.
fn endpoint_label(href: &str) -> &str {
    let host = href
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host.ends_with("github.com") {
        "GitHub"
    } else if host.contains("cloudflare") || host.ends_with("r2.dev") || host == "wingharness.dpdns.org"
    {
        "Cloudflare"
    } else {
        "Mirror"
    }
}

/// The key `platforms` uses for this machine — the updater's own target
/// spelling, which is what the release workflow writes.
fn target_key() -> Option<&'static str> {
    match (cfg!(target_os = "windows"), cfg!(target_arch = "x86_64"), cfg!(target_arch = "aarch64")) {
        (true, true, _) => Some("windows-x86_64"),
        (true, _, true) => Some("windows-aarch64"),
        _ => None,
    }
}

/// Verifies a downloaded archive and hands its bytes to the frontend.
///
/// The size is checked before the file is read, so a wrong URL fails without
/// pulling a large file into memory, and the checksum after it. Both come from
/// the manifest the download URL came from, so this validates the transfer, not
/// the release itself.
pub fn read_archive(path: &str, sha256: &str, size: u64) -> Result<Response, String> {
    let path = Path::new(path);
    if !path.is_file() {
        return Err("The downloaded archive is missing.".to_string());
    }
    let actual = std::fs::metadata(path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?
        .len();
    if actual > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "The archive is larger than {} MiB.",
            MAX_ARCHIVE_BYTES / 1024 / 1024
        ));
    }
    if actual != size {
        return Err(format!(
            "The archive is {actual} bytes, the release manifest says {size}."
        ));
    }

    let bytes = std::fs::read(path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let digest = hex(&Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(sha256.trim()) {
        return Err(format!(
            "The archive's checksum is {digest}, the release manifest says {}. It was downloaded \
             damaged; try again.",
            sha256.trim()
        ));
    }
    Ok(Response::new(bytes))
}

/// Empties the install directory, keeping the directory itself.
///
/// An update replaces the whole tree rather than merging into it: a file the new
/// export no longer has would otherwise stay behind and be served by the new
/// server.
pub fn clear(app: &AppHandle) -> Result<(), String> {
    server::assert_stopped(app, "replacing codeg-server")?;

    let dir = paths().dir;
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;
        return Ok(());
    }

    for entry in std::fs::read_dir(&dir)
        .map_err(|error| format!("Cannot read {}: {error}", dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Cannot read {}: {error}", dir.display()))?;
        let path = entry.path();
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        removed.map_err(|error| {
            format!(
                "Cannot remove {}: {error}. A running codeg-server holds it; stop the server and \
                 try again.",
                path.display()
            )
        })?;
    }
    Ok(())
}

/// Writes one unpacked file into the install directory.
///
/// The raw body carries the metadata so a file's bytes never travel through
/// JSON: `[name length: u32 little-endian][name: UTF-8][content]`.
pub fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Expected a raw request body.".to_string());
    };
    let (relative, content) = parse_entry(body)?;

    let base = paths().dir;
    let target = resolve_entry(&base, relative)?;
    let parent = target
        .parent()
        .ok_or_else(|| "The install entry has no parent directory.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    write_atomic(&target, content)
}

/// Records a finished install, once both halves are actually on disk.
pub fn finish(
    version: String,
    tag: String,
    sha256: String,
    size: u64,
    endpoint: String,
    url: String,
) -> Result<InstallView, String> {
    let paths = paths();
    if !paths.server_path.is_file() {
        return Err(format!(
            "The archive did not contain {}; nothing was installed.",
            paths.server_path.display()
        ));
    }
    if !paths.static_dir.is_dir() {
        return Err(format!(
            "The archive did not contain the {WEB_DIR} folder beside the executable at {}; nothing \
             was installed.",
            paths.dir.display()
        ));
    }

    let record = InstallRecord {
        version,
        tag,
        sha256,
        size,
        endpoint,
        url,
        installed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_secs())
            .unwrap_or_default(),
    };
    let text = serde_json::to_string_pretty(&record)
        .map_err(|error| format!("Cannot encode the install record: {error}"))?;
    let path = paths.dir.join(RECORD_FILE);
    std::fs::write(&path, format!("{text}\n"))
        .map_err(|error| format!("Cannot write {}: {error}", path.display()))?;

    Ok(view())
}

/// Splits `[name length][name][content]` into its two parts.
fn parse_entry(body: &[u8]) -> Result<(&str, &[u8]), String> {
    if body.len() < 4 {
        return Err("The install payload is truncated.".to_string());
    }
    let name_length = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if name_length == 0 || name_length > MAX_RELATIVE_PATH {
        return Err("The install entry name is invalid.".to_string());
    }
    let name_end = 4usize
        .checked_add(name_length)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| "The install payload is truncated.".to_string())?;
    let relative = std::str::from_utf8(&body[4..name_end])
        .map_err(|_| "The install entry name is not valid UTF-8.".to_string())?;
    Ok((relative, &body[name_end..]))
}

/// Turns an archive entry name into a path under `base`.
///
/// Both separators are accepted because a Windows tool sometimes emits `/` and
/// a Unix-made archive always does. Every escaping or reserved form is refused
/// here, not only in the frontend: an archive is untrusted input.
fn resolve_entry(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() {
        return Err("The install entry name is empty.".to_string());
    }
    if relative.len() > MAX_RELATIVE_PATH {
        return Err("The install entry name is too long.".to_string());
    }

    let mut components = Vec::new();
    for part in relative.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("The install entry name is unsafe: {relative}"));
        }
        if part.contains('\0') || part.chars().any(char::is_control) {
            return Err(format!("The install entry name is unsafe: {relative}"));
        }
        if cfg!(windows) {
            // Alternate data streams, drive letters and trailing dots/spaces
            // all alias a different file on Windows than the name suggests.
            if part.contains(':') || part.ends_with('.') || part.ends_with(' ') {
                return Err(format!("The install entry name is unsafe: {relative}"));
            }
            if is_reserved_device(part) {
                return Err(format!("The install entry name is reserved: {relative}"));
            }
        }
        components.push(part);
    }

    // The record describes the install; an archive may not write it.
    if components.len() == 1 && components[0].eq_ignore_ascii_case(RECORD_FILE) {
        return Err("The archive may not replace the install record.".to_string());
    }

    let mut target = base.to_path_buf();
    for part in components {
        target.push(part);
    }
    Ok(target)
}

fn is_reserved_device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4"
            | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

/// Writes through a sibling temp file and renames, so a failed write does not
/// leave a half-written `codeg-server.exe` for the next start to run.
fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path: {}", path.display()))?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "codeg".to_string());
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temp, content).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Cannot write {}: {error}", path.display())
    })?;
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Cannot write {}: {error}", path.display())
    })
}

/// Lower-case hex, which is how the release workflow writes the checksum.
fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(relative: &str) -> Result<PathBuf, String> {
        resolve_entry(Path::new("C:/data/codeg-server"), relative)
    }

    #[test]
    fn plain_files_and_nested_entries_resolve() {
        assert_eq!(
            entry("codeg-server.exe").unwrap(),
            PathBuf::from("C:/data/codeg-server/codeg-server.exe")
        );
        assert_eq!(
            entry("web/_next/static/chunk.js").unwrap(),
            PathBuf::from("C:/data/codeg-server/web/_next/static/chunk.js")
        );
        assert_eq!(
            entry("web\\index.html").unwrap(),
            PathBuf::from("C:/data/codeg-server/web/index.html")
        );
    }

    #[test]
    fn escaping_names_are_refused() {
        assert!(entry("../codeg/clash.json").is_err());
        assert!(entry("web/../../escape").is_err());
        assert!(entry("").is_err());
        assert!(entry("/absolute").is_err());
        assert!(entry("bad\0name").is_err());
    }

    #[test]
    fn the_install_record_cannot_be_replaced() {
        assert!(entry("install.json").is_err());
        assert!(entry("INSTALL.JSON").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_aliases_and_devices_are_refused() {
        assert!(entry("C:evil").is_err());
        assert!(entry("web/file.txt:stream").is_err());
        assert!(entry("web/trailing.").is_err());
        assert!(entry("web/trailing ").is_err());
        assert!(entry("CON").is_err());
        assert!(entry("nul.txt").is_err());
    }

    fn payload(name: &str, content: &[u8]) -> Vec<u8> {
        let name = name.as_bytes();
        let mut body = Vec::with_capacity(4 + name.len() + content.len());
        body.extend_from_slice(&(name.len() as u32).to_le_bytes());
        body.extend_from_slice(name);
        body.extend_from_slice(content);
        body
    }

    #[test]
    fn payload_carries_name_and_content() {
        let body = payload("web/index.html", b"<!doctype html>");
        let (name, content) = parse_entry(&body).expect("valid payload");
        assert_eq!(name, "web/index.html");
        assert_eq!(content, b"<!doctype html>");
    }

    #[test]
    fn malformed_payloads_are_refused() {
        assert!(parse_entry(&[]).is_err());
        assert!(parse_entry(&[0]).is_err());

        let mut empty_name = payload("x", b"y");
        empty_name[0] = 0;
        empty_name[1] = 0;
        empty_name[2] = 0;
        empty_name[3] = 0;
        assert!(parse_entry(&empty_name).is_err());

        let mut overlong_name = payload("x", b"y");
        overlong_name[0] = 200;
        assert!(parse_entry(&overlong_name).is_err());

        let mut invalid_utf8 = payload("x", b"y");
        invalid_utf8[4] = 0xFF;
        assert!(parse_entry(&invalid_utf8).is_err());
    }

    #[test]
    fn checksums_are_lower_case_hex() {
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn mirrors_have_short_labels() {
        assert_eq!(
            endpoint_label("https://github.com/Anfioo/codeg/releases/latest/download/server.json"),
            "GitHub"
        );
        assert_eq!(
            endpoint_label("https://wingharness.dpdns.org/WhCodeg/latest/server.json"),
            "Cloudflare"
        );
        assert_eq!(endpoint_label("https://mirror.example.test/server.json"), "Mirror");
    }

    #[test]
    fn the_manifest_target_is_the_updater_spelling() {
        if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            assert_eq!(target_key(), Some("windows-x86_64"));
        }
    }
}
