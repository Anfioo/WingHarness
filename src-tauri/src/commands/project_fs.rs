//! The project's files, served to codelet's `remote` extension.
//!
//! The notes page loads every file into memory, which is right for a folder of
//! a few `.md`. A project is not that: it holds `.git`, `node_modules`, build
//! output — any of it can run to gigabytes. So the project page reads on demand
//! instead, one directory level at a time, and these commands are the other end
//! of that. Every path is relative to the configured root and is refused unless
//! it stays inside it, and `.git` is never served.
//!
//! The shapes match `codelet/dist/_chunks/protocol.d.mts` — the wire between
//! `codelet/extensions/remote` and its transport.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::commands::fs_guard::{relative_posix, safe_join};
use crate::config;

/// Refused: serving it would carry the whole history in a listing, and nothing
/// downstream wants it. Mirrors the `remote` extension's own default.
const EXCLUDE: &[&str] = &[".git"];

/// Bytes a file may have and still be offered as text. The same 4 MiB the
/// protocol's own server defaults to; past it the entry is listed, not read.
const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub version: u32,
    pub readonly: bool,
    pub max_file_size: u64,
    pub features: Vec<String>,
}

#[derive(Serialize)]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<RemoteEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Serialize)]
pub struct TreeResult {
    pub entry: RemoteEntry,
}

#[derive(Serialize)]
pub struct ReadResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub mtime: u64,
    pub size: u64,
    pub etag: String,
}

/// The configured project root, or a message saying it is not set.
///
/// An empty root is the normal "no project chosen yet" state rather than an
/// error, so it is reported the same way as a path that no longer exists.
///
/// `pub(crate)` so the preview backend's root provider can install it — the
/// `file-preview` crate is handed this function at startup and calls it fresh
/// on every read.
pub(crate) fn repo_root() -> Result<std::path::PathBuf, String> {
    let configured = config::load().workspace.root;
    let root = configured.trim();
    if root.is_empty() {
        return Err("未配置项目路径，请先到「设置 → 项目」填写。".to_string());
    }
    let path = std::path::PathBuf::from(root);
    if !path.is_dir() {
        return Err(format!("项目路径不存在或不是目录：{root}"));
    }
    Ok(path)
}

/// Whether a root-relative path names something never served.
///
/// `relative_posix` yields a leading slash, so one is stripped before the
/// comparison; a name only ever matches at the root, which is what the
/// `remote` extension's own default does too.
fn excluded(rel: &str) -> bool {
    let rel = rel.trim_start_matches('/');
    EXCLUDE
        .iter()
        .any(|name| rel == *name || rel.starts_with(&format!("{name}/")))
}

/// Whether a file's opening bytes look like text.
///
/// Codelet's own server decides this by extension first and only falls back to
/// reading a file when it is about to send the text anyway, which is what keeps
/// a directory listing from opening every file in it. This is that same cheap
/// test.
fn is_binary_name(path: &Path) -> bool {
    const BINARY: &[&str] = &[
        // Media and archives the reference server maps to a MIME type.
        "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "mp4", "webm", "ogv", "mov",
        "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "pdf", "zip", "gz", "wasm", "woff",
        "woff2", "ttf", "otf",
        // And the ones it names outright, there being no MIME type to give them.
        "exe", "dll", "so", "dylib", "o", "a", "node", "class", "jar", "pyc", "tar", "7z", "rar",
        "bz2", "xz", "zst", "bin", "dat", "db", "sqlite", "sqlite3", "eot",
    ];
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => BINARY.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Milliseconds since the epoch, the unit `RemoteEntry` and `mtime` use.
fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// An opaque change tag: a write carries the one it read, and a mismatch is a
/// conflict. Size and mtime are free from the `stat` a listing already made.
fn etag_of(size: u64, mtime: u64) -> String {
    format!("{size}-{mtime}")
}

/// Normalizes CRLF and lone CR to LF.
///
/// The editor's document model is LF: a change set is split on `/\r\n?|\n/`, so
/// a `\r\n` put through the editor comes back as `\n`. Handing it CRLF means the
/// two sides disagree from the first frame — opening a file marks it modified,
/// and saving rewrites every line. Text crosses this boundary as LF, and the
/// file's own endings are restored on the way out.
fn to_lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Whether bytes on disk use CRLF, which decides the endings a save restores.
fn uses_crlf(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|pair| pair == b"\r\n")
}

/// What the transport asks once, at connect time.
#[tauri::command]
pub fn project_info() -> Result<RemoteInfo, String> {
    // Resolve so a missing or mis-set path fails here, loudly, rather than as
    // an empty tree.
    repo_root()?;
    Ok(RemoteInfo {
        name: "codelet-server".into(),
        version: 1,
        readonly: false,
        max_file_size: MAX_FILE_SIZE,
        // No file watcher: a project changes behind the app, and the toolbar
        // refreshes on demand. A feed would be a second thing to keep alive for
        // little the reader cannot already ask for.
        features: Vec::<String>::new(),
    })
}

/// Lists one directory level, or the whole tree when `depth` is `"all"`.
///
/// `content` inlines each text file's body. The page asks for neither by
/// default — one level, names only — which is what keeps the cost of a large
/// project to what is actually on screen.
#[tauri::command]
pub fn project_tree(
    path: Option<String>,
    depth: Option<serde_json::Value>,
    content: Option<bool>,
) -> Result<TreeResult, String> {
    let root = repo_root()?;
    let requested = path.unwrap_or_else(|| "/".into());
    let all = depth.as_ref().is_some_and(|d| d.as_str() == Some("all"));
    let levels: usize = if all {
        usize::MAX
    } else {
        depth
            .as_ref()
            .and_then(|d| d.as_u64())
            .unwrap_or(1)
            .max(1) as usize
    };
    let with_content = content.unwrap_or(false);

    let entry = if requested.trim_matches('/').is_empty() {
        entry_for(&root, &root, levels, with_content)?
    } else {
        let target = safe_join(&root, &requested)?;
        if excluded_entry(&root, &target) {
            return Err(format!("拒绝访问：{requested}"));
        }
        entry_for(&root, &target, levels, with_content)?
    };
    Ok(TreeResult { entry })
}

fn excluded_entry(root: &Path, path: &Path) -> bool {
    excluded(&relative_posix(root, path))
}

/// Builds one entry, recursing while `levels` remain.
fn entry_for(root: &Path, path: &Path, levels: usize, content: bool) -> Result<RemoteEntry, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取 {path:?} 失败：{e}"))?;
    let joined = relative_posix(root, path);
    // The client addresses the root as `/`, and gives it no basename — a path
    // of `""` would name nothing, and `relative_posix` yields that for the root.
    let rel = if joined.is_empty() { "/".to_string() } else { joined };
    let name = if rel == "/" {
        String::new()
    } else {
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    };

    if metadata.is_dir() {
        // `children` is present only when this call actually descended. Absent
        // means "not loaded yet", which is what makes the client fetch the
        // level on expand; an empty array would claim the directory is empty
        // and it would never be asked for.
        let mut children = Vec::new();
        if levels > 0 {
            let mut entries: Vec<_> = fs::read_dir(path)
                .map_err(|e| format!("读取目录 {path:?} 失败：{e}"))?
                .flatten()
                .map(|e| e.path())
                .filter(|p| !excluded_entry(root, p))
                .collect();
            // Directories before files, each alphabetical — the same order the
            // reference server sends, which is what the tree expects to draw.
            entries.sort_by(|a, b| {
                let (a_dir, b_dir) = (a.is_dir(), b.is_dir());
                b_dir
                    .cmp(&a_dir)
                    .then_with(|| a.file_name().cmp(&b.file_name()))
            });
            for child in entries {
                children.push(entry_for(root, &child, levels - 1, content)?);
            }
        }
        return Ok(RemoteEntry {
            name,
            path: rel,
            kind: "directory".into(),
            size: None,
            mtime: metadata.modified().ok().map(millis),
            binary: None,
            children: (levels > 0).then_some(children),
            text: None,
            truncated: None,
        });
    }

    let size = metadata.len();
    let mtime = metadata.modified().ok().map(millis);
    let over_cap = size > MAX_FILE_SIZE;

    // Past the cap the entry is listed and never read; the client shows why.
    // Under the cap, `content` decides whether the body rides along; without
    // it the file is only classified, and that is a name check — opening every
    // file in a directory to look at it would be the listing's whole cost.
    let mut binary = is_binary_name(path);
    let mut text = None;
    if over_cap {
        binary = true;
    } else if content && !binary {
        match fs::read(path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(value) => text = Some(to_lf(&value)),
                Err(_) => binary = true,
            },
            Err(_) => binary = true,
        }
    }

    Ok(RemoteEntry {
        name,
        path: rel,
        kind: "file".into(),
        size: Some(size),
        mtime,
        binary: binary.then_some(true),
        children: None,
        text,
        truncated: over_cap.then_some(true),
    })
}

/// The bytes of a text file, with the tag a later write compares against.
#[tauri::command]
pub fn project_read(path: String) -> Result<ReadResult, String> {
    let root = repo_root()?;
    let target = safe_join(&root, &path)?;
    if excluded_entry(&root, &target) {
        return Err(format!("拒绝访问：{path}"));
    }
    let metadata = fs::metadata(&target).map_err(|e| format!("读取 {path} 失败：{e}"))?;
    if metadata.is_dir() {
        return Err(format!("{path} 是目录。"));
    }
    let mtime = metadata.modified().ok().map(millis).unwrap_or(0);
    let bytes = fs::read(&target).map_err(|e| format!("读取 {path} 失败：{e}"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("{path} 不是文本文件，无法读取。"))?;
    Ok(ReadResult {
        text: to_lf(&text),
        etag: Some(etag_of(metadata.len(), mtime)),
    })
}

/// Writes a text file, creating missing parents.
///
/// `etag` is the compare-and-set tag from the read or the last write; a
/// mismatch means the file changed underneath and the write is refused rather
/// than clobbering it.
#[tauri::command]
pub fn project_write(path: String, body: String, etag: Option<String>) -> Result<WriteResult, String> {
    let root = repo_root()?;
    let target = safe_join(&root, &path)?;
    if excluded_entry(&root, &target) {
        return Err(format!("拒绝访问：{path}"));
    }
    if let Some(expected) = etag {
        if let Ok(current) = fs::metadata(&target) {
            let current_tag =
                etag_of(current.len(), current.modified().ok().map(millis).unwrap_or(0));
            if current_tag != expected {
                return Err(format!("{path} 已在磁盘上被修改，请重新打开后再编辑。"));
            }
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {parent:?} 失败：{e}"))?;
    }
    // The body arrives as LF; restore the endings the file already had so a save
    // does not turn a CRLF file into LF and show up as a whole-file diff. A
    // file that does not exist yet is written as sent.
    let body = to_lf(&body);
    let body = if fs::read(&target).is_ok_and(|existing| uses_crlf(&existing)) {
        body.replace('\n', "\r\n")
    } else {
        body
    };
    fs::write(&target, body.as_bytes()).map_err(|e| format!("写入 {path} 失败：{e}"))?;
    let metadata = fs::metadata(&target).map_err(|e| format!("写入后读取 {path} 失败：{e}"))?;
    let mtime = metadata.modified().ok().map(millis).unwrap_or(0);
    Ok(WriteResult {
        mtime,
        size: metadata.len(),
        etag: etag_of(metadata.len(), mtime),
    })
}

/// Creates a directory, and the ones above it.
#[tauri::command]
pub fn project_mkdir(path: String) -> Result<(), String> {
    let root = repo_root()?;
    let target = safe_join(&root, &path)?;
    if excluded_entry(&root, &target) {
        return Err(format!("拒绝访问：{path}"));
    }
    fs::create_dir_all(&target).map_err(|e| format!("创建目录 {path} 失败：{e}"))
}

/// Moves or renames a file or directory, creating the destination's parents.
#[tauri::command]
pub fn project_move(from: String, to: String) -> Result<(), String> {
    let root = repo_root()?;
    let source = safe_join(&root, &from)?;
    let destination = safe_join(&root, &to)?;
    if excluded_entry(&root, &source) || excluded_entry(&root, &destination) {
        return Err(format!("拒绝访问：{from} → {to}"));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 {parent:?} 失败：{e}"))?;
    }
    fs::rename(&source, &destination).map_err(|e| format!("移动 {from} 失败：{e}"))
}

/// Removes a file, or a directory and everything under it.
#[tauri::command]
pub fn project_delete(path: String) -> Result<(), String> {
    let root = repo_root()?;
    let target = safe_join(&root, &path)?;
    if excluded_entry(&root, &target) {
        return Err(format!("拒绝访问：{path}"));
    }
    let metadata = fs::metadata(&target).map_err(|e| format!("读取 {path} 失败：{e}"))?;
    let result = if metadata.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    result.map_err(|e| format!("删除 {path} 失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_dot_git_at_any_depth() {
        assert!(excluded(".git"));
        assert!(excluded(".git/config"));
        assert!(excluded(".git/objects/ab/cd"));
        assert!(!excluded("src/main.rs"));
        assert!(!excluded(".gitignore"));
        assert!(!excluded("src/.git/hooks"));
    }

    #[test]
    fn etag_is_stable_for_equal_stats() {
        assert_eq!(etag_of(10, 20), etag_of(10, 20));
        assert_ne!(etag_of(10, 20), etag_of(11, 20));
        assert_ne!(etag_of(10, 20), etag_of(10, 21));
    }

    #[test]
    fn to_lf_flattens_every_ending() {
        assert_eq!(to_lf("a\r\nb\r\n"), "a\nb\n");
        assert_eq!(to_lf("a\rb"), "a\nb");
        assert_eq!(to_lf("a\nb"), "a\nb");
        assert_eq!(to_lf(""), "");
    }

    #[test]
    fn uses_crlf_reads_the_bytes() {
        assert!(uses_crlf(b"a\r\nb"));
        assert!(!uses_crlf(b"a\nb"));
        assert!(!uses_crlf(b""));
    }
}
