//! File bridge for the runtime installer.
//!
//! The runtime archives are fetched and unpacked in the webview: the official
//! and user-supplied URLs go through the frontend's `fetch`, and 7-Zip is the
//! `7z-wasm` build the preview already bundles. Rust owns none of that. It only
//! moves bytes across the boundary — it hands a picked archive to the frontend
//! and writes the unpacked entries back into the directory the feature owns.
//!
//! Two directories exist, both under the app's data directory:
//!
//! ```text
//! clash/  mihomo.exe and its geo databases
//! frp/    frpc.exe
//! ```
//!
//! The write command must not become a general "write anywhere under the data
//! directory" capability: an archive is untrusted input, and `clash.json` /
//! `frp.json` hold the user's settings. Paths that would replace those control
//! files or their sibling directories are refused.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::config;

/// An archive is read into webview memory before it is unpacked, so an
/// accidental giant file should fail before it is read rather than after.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

/// Longest relative path the frontend may send. Runtime archives are flat and
/// short; anything longer is a malformed archive, not a path worth writing.
const MAX_RELATIVE_PATH: usize = 512;

/// Kind bytes in the raw write payload; `runtime_target` uses the names.
const KIND_CLASH: u8 = 0;
const KIND_FRP: u8 = 1;

#[derive(Debug, Clone, Copy)]
enum RuntimeKind {
    Clash,
    Frp,
}

impl RuntimeKind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "clash" => Ok(Self::Clash),
            "frp" => Ok(Self::Frp),
            _ => Err("Unknown runtime kind.".to_string()),
        }
    }

    fn from_byte(raw: u8) -> Result<Self, String> {
        match raw {
            KIND_CLASH => Ok(Self::Clash),
            KIND_FRP => Ok(Self::Frp),
            _ => Err("Unknown runtime kind.".to_string()),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Clash => "clash",
            Self::Frp => "frp",
        }
    }

    fn dir(self) -> PathBuf {
        config::dir().join(self.name())
    }

    fn binary(self) -> &'static str {
        match (self, cfg!(windows)) {
            (Self::Clash, true) => "mihomo.exe",
            (Self::Clash, false) => "mihomo",
            (Self::Frp, true) => "frpc.exe",
            (Self::Frp, false) => "frpc",
        }
    }

    /// Entries at the root of the runtime directory that belong to the feature
    /// itself. An archive may replace the binaries, never the store beside them.
    fn protected(self) -> &'static [&'static str] {
        match self {
            Self::Clash => &[
                "clash.json",
                "subscriptions.json",
                "tests.json",
                "sysproxy",
                "prism",
                "profiles",
                "run",
            ],
            Self::Frp => &["frp.json", "profiles", "logs"],
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTarget {
    pub kind: String,
    pub dir: String,
    pub binary: String,
    pub installed: bool,
}

/// Where a runtime kind installs to, and whether its binary is already there.
#[tauri::command]
pub fn runtime_target(kind: String) -> Result<RuntimeTarget, String> {
    let kind = RuntimeKind::parse(&kind)?;
    let dir = kind.dir();
    // "Open folder" is offered before the first install, so the directory has
    // to exist even when there is nothing in it yet.
    let _ = std::fs::create_dir_all(&dir);
    let binary = dir.join(kind.binary());
    Ok(RuntimeTarget {
        kind: kind.name().to_string(),
        dir: dir.to_string_lossy().to_string(),
        binary: binary.to_string_lossy().to_string(),
        installed: binary.is_file(),
    })
}

/// Read a locally picked archive and hand its bytes to the frontend.
///
/// The picker already narrowed the file to an archive, but the command is on a
/// different trust boundary: keep the extension check and the size cap here.
#[tauri::command]
pub fn runtime_read_archive(path: String) -> Result<Response, String> {
    let path = Path::new(&path);
    if !path.is_file() {
        return Err("The selected archive does not exist.".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("7z") | Some("zip")) {
        return Err("Only .7z and .zip archives are supported.".to_string());
    }
    let size = std::fs::metadata(path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?
        .len();
    if size > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "The archive is larger than {} MiB.",
            MAX_ARCHIVE_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    Ok(Response::new(bytes))
}

/// Write one unpacked file into the runtime directory.
///
/// The raw body carries the metadata so a file's bytes never travel through
/// JSON: `[kind: 1 byte][path length: u32 little-endian][path: UTF-8][content]`.
/// The frontend sends one request per file.
#[tauri::command]
pub fn runtime_write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Expected a raw request body.".to_string());
    };
    let (kind, relative, content) = parse_payload(body)?;

    let base = kind.dir();
    let target = resolve_entry(&base, kind, relative)?;
    let parent = target
        .parent()
        .ok_or_else(|| "The runtime entry has no parent directory.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    write_atomic(&target, content)?;
    Ok(())
}

/// Split `[kind][name length][name][content]` into its three parts.
fn parse_payload(body: &[u8]) -> Result<(RuntimeKind, &str, &[u8]), String> {
    if body.len() < 5 {
        return Err("The runtime payload is truncated.".to_string());
    }
    let kind = RuntimeKind::from_byte(body[0])?;
    let name_length = u32::from_le_bytes([body[1], body[2], body[3], body[4]]) as usize;
    if name_length == 0 || name_length > MAX_RELATIVE_PATH {
        return Err("The runtime entry name is invalid.".to_string());
    }
    let name_end = 5usize
        .checked_add(name_length)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| "The runtime payload is truncated.".to_string())?;
    let relative = std::str::from_utf8(&body[5..name_end])
        .map_err(|_| "The runtime entry name is not valid UTF-8.".to_string())?;
    Ok((kind, relative, &body[name_end..]))
}

/// Turn an archive entry name into a path under `base`.
///
/// Both separators are accepted because a Windows tool sometimes emits `/` and
/// a Unix-made archive always does. Every escaping or reserved form is refused
/// here, not only in the frontend.
fn resolve_entry(base: &Path, kind: RuntimeKind, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() {
        return Err("The runtime entry name is empty.".to_string());
    }
    if relative.len() > MAX_RELATIVE_PATH {
        return Err("The runtime entry name is too long.".to_string());
    }

    let mut components = Vec::new();
    for part in relative.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("The runtime entry name is unsafe: {relative}"));
        }
        if part.contains('\0') || part.chars().any(char::is_control) {
            return Err(format!("The runtime entry name is unsafe: {relative}"));
        }
        if cfg!(windows) {
            // Alternate data streams, drive letters and trailing dots/spaces
            // all alias a different file on Windows than the name suggests.
            if part.contains(':') || part.ends_with('.') || part.ends_with(' ') {
                return Err(format!("The runtime entry name is unsafe: {relative}"));
            }
            if is_reserved_device(part) {
                return Err(format!("The runtime entry name is reserved: {relative}"));
            }
        }
        components.push(part);
    }

    let first = components
        .first()
        .ok_or_else(|| "The runtime entry name is empty.".to_string())?;
    if kind
        .protected()
        .iter()
        .any(|name| name.eq_ignore_ascii_case(first))
    {
        return Err(format!(
            "The archive may not replace the runtime's own store: {first}"
        ));
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

/// Write through a sibling temp file and rename, so a failed write does not
/// leave a half-written `mihomo.exe` for the next start to run.
fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path: {}", path.display()))?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "runtime".to_string());
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temp, content).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Cannot write {}: {error}", path.display())
    })?;
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!(
            "Cannot write {}: {error}. A running mihomo or frpc may hold the file; stop it and retry.",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(relative: &str) -> Result<PathBuf, String> {
        resolve_entry(Path::new("C:/data/clash"), RuntimeKind::Clash, relative)
    }

    #[test]
    fn plain_files_and_nested_entries_resolve() {
        assert_eq!(
            entry("mihomo.exe").unwrap(),
            PathBuf::from("C:/data/clash/mihomo.exe")
        );
        assert_eq!(
            entry("assets/geoip.dat").unwrap(),
            PathBuf::from("C:/data/clash/assets/geoip.dat")
        );
        assert_eq!(
            entry("assets\\geoip.dat").unwrap(),
            PathBuf::from("C:/data/clash/assets/geoip.dat")
        );
    }

    #[test]
    fn escaping_names_are_refused() {
        assert!(entry("../frp/frpc.exe").is_err());
        assert!(entry("x/../../escape").is_err());
        assert!(entry("").is_err());
        assert!(entry("/absolute").is_err());
        assert!(entry("bad\0name").is_err());
    }

    #[test]
    fn the_store_beside_the_binary_cannot_be_replaced() {
        assert!(entry("clash.json").is_err());
        assert!(entry("CLASH.JSON").is_err());
        assert!(entry("prism/groups.json").is_err());
        assert!(entry("run/config.yaml").is_err());
        assert!(entry("profiles/new.yaml").is_err());
    }

    #[test]
    fn frp_protects_its_own_files() {
        let base = Path::new("C:/data/frp");
        assert!(resolve_entry(base, RuntimeKind::Frp, "frp.json").is_err());
        assert!(resolve_entry(base, RuntimeKind::Frp, "logs/x.log").is_err());
        assert!(resolve_entry(base, RuntimeKind::Frp, "frpc.exe").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_aliases_and_devices_are_refused() {
        assert!(entry("C:evil").is_err());
        assert!(entry("file.txt:stream").is_err());
        assert!(entry("trailing.").is_err());
        assert!(entry("trailing ").is_err());
        assert!(entry("CON").is_err());
        assert!(entry("nul.txt").is_err());
    }

    fn payload(kind: u8, name: &str, content: &[u8]) -> Vec<u8> {
        let name = name.as_bytes();
        let mut body = Vec::with_capacity(5 + name.len() + content.len());
        body.push(kind);
        body.extend_from_slice(&(name.len() as u32).to_le_bytes());
        body.extend_from_slice(name);
        body.extend_from_slice(content);
        body
    }

    #[test]
    fn payload_carries_kind_name_and_content() {
        let body = payload(1, "frpc.exe", b"binary");
        let (kind, name, content) = parse_payload(&body).expect("valid payload");
        assert!(matches!(kind, RuntimeKind::Frp));
        assert_eq!(name, "frpc.exe");
        assert_eq!(content, b"binary");
    }

    #[test]
    fn malformed_payloads_are_refused() {
        assert!(parse_payload(&[]).is_err());
        assert!(parse_payload(&[0]).is_err());

        let mut unknown_kind = payload(0, "x", b"y");
        unknown_kind[0] = 9;
        assert!(parse_payload(&unknown_kind).is_err());

        let mut empty_name = payload(0, "", b"y");
        empty_name[1] = 0;
        assert!(parse_payload(&empty_name).is_err());

        let mut overlong_name = payload(0, "x", b"y");
        overlong_name[1] = 200;
        assert!(parse_payload(&overlong_name).is_err());

        let mut invalid_utf8 = payload(0, "x", b"y");
        invalid_utf8[5] = 0xFF;
        assert!(parse_payload(&invalid_utf8).is_err());
    }

    #[test]
    fn kind_names_and_bytes_are_exact() {
        assert!(matches!(RuntimeKind::parse("clash"), Ok(RuntimeKind::Clash)));
        assert!(matches!(RuntimeKind::parse("frp"), Ok(RuntimeKind::Frp)));
        assert!(RuntimeKind::parse("Clash").is_err());
        assert!(RuntimeKind::parse("").is_err());
        assert!(matches!(RuntimeKind::from_byte(0), Ok(RuntimeKind::Clash)));
        assert!(matches!(RuntimeKind::from_byte(1), Ok(RuntimeKind::Frp)));
        assert!(RuntimeKind::from_byte(2).is_err());
    }
}
