//! Remote path helpers: normalisation, parent, and collision naming.
//!
//! Every write goes through here so a crafted path cannot escape the directory
//! the user is looking at (plan R5).

use crate::error::{ServerError, ServerResult};

/// Collapse repeated slashes and resolve `.` / `..` without leaving `/`.
///
/// The result keeps the input's absolute / relative nature: an absolute input
/// yields an absolute result whose `..` never climbs above `/`, a relative
/// input keeps a leading `..` because only the server knows the working
/// directory it would resolve against.
pub fn normalize(path: &str) -> ServerResult<String> {
    if path.is_empty() || path.contains('\0') {
        return Err(ServerError::path_invalid(path));
    }

    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();

    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match parts.last() {
                Some(last) if *last != ".." => {
                    parts.pop();
                }
                _ => {
                    if !absolute {
                        parts.push("..");
                    }
                }
            },
            name => parts.push(name),
        }
    }

    if parts.is_empty() {
        return Ok(if absolute { "/" } else { "." }.to_string());
    }

    let joined = parts.join("/");
    Ok(if absolute {
        format!("/{}", joined)
    } else {
        joined
    })
}

/// Parent directory of a remote path, keeping `/` as its own parent.
pub fn parent(path: &str) -> ServerResult<String> {
    let normalized = normalize(path)?;
    match normalized.rfind('/') {
        None => Ok(".".to_string()),
        Some(0) => Ok("/".to_string()),
        Some(index) => Ok(normalized[..index].to_string()),
    }
}

/// Join one entry name onto a directory. `name` must be a single segment, so a
/// listing row can never smuggle a path of its own into an operation.
pub fn join(parent: &str, name: &str) -> ServerResult<String> {
    if !is_segment(name) {
        return Err(ServerError::path_invalid(name));
    }

    let parent = normalize(parent)?;
    if parent.ends_with('/') {
        Ok(format!("{}{}", parent, name))
    } else {
        Ok(format!("{}/{}", parent, name))
    }
}

/// Whether `name` is one path segment: no separators, not empty, not `.`/`..`.
pub fn is_segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\0')
}

/// `name (1).ext` — the name used when the conflict policy is `rename`.
pub fn collision_name(name: &str, index: u32) -> ServerResult<String> {
    if !is_segment(name) {
        return Err(ServerError::path_invalid(name));
    }

    let (stem, extension) = match name.rfind('.') {
        Some(position) if position > 0 => (&name[..position], &name[position..]),
        _ => (name, ""),
    };

    Ok(format!("{} ({}){}", stem, index, extension))
}

/// Make a remote name safe to land on a Windows filesystem.
///
/// Only the local copy is cleaned: the remote name is never rewritten, so a
/// download keeps its bytes and the rename is purely a landing concern.
pub fn sanitize_local_name(name: &str) -> String {
    let mut cleaned = String::with_capacity(name.len());
    for character in name.chars() {
        let invalid = matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || (character as u32) < 0x20;
        cleaned.push(if invalid { '_' } else { character });
    }

    // Windows silently strips trailing dots and spaces, which would make the
    // landed name differ from the one we report.
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        cleaned.insert(0, '_');
    }

    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServerErrorCode;

    fn code(path: &str) -> ServerErrorCode {
        normalize(path).unwrap_err().code
    }

    #[test]
    fn keeps_root() {
        assert_eq!(normalize("/").unwrap(), "/");
        assert_eq!(normalize("//").unwrap(), "/");
        assert_eq!(normalize("/..").unwrap(), "/");
        assert_eq!(normalize("/../..").unwrap(), "/");
    }

    #[test]
    fn stops_at_the_root() {
        assert_eq!(normalize("/a/../../b").unwrap(), "/b");
        assert_eq!(normalize("/./a").unwrap(), "/a");
    }

    #[test]
    fn keeps_relative_dotdot() {
        assert_eq!(normalize("..").unwrap(), "..");
        assert_eq!(normalize("a/../..").unwrap(), "..");
        assert_eq!(normalize(".").unwrap(), ".");
        assert_eq!(normalize("a/../b").unwrap(), "b");
    }

    #[test]
    fn folds_repeated_slashes() {
        assert_eq!(normalize("a//b").unwrap(), "a/b");
        assert_eq!(normalize("/a//b/").unwrap(), "/a/b");
        assert_eq!(normalize("/a/b/").unwrap(), "/a/b");
    }

    #[test]
    fn removes_single_dots() {
        assert_eq!(normalize("a/./b").unwrap(), "a/b");
        assert_eq!(normalize("/a/./b/.").unwrap(), "/a/b");
    }

    #[test]
    fn keeps_unicode_names() {
        assert_eq!(normalize("/资料/说明.txt").unwrap(), "/资料/说明.txt");
        assert_eq!(normalize("/资料//说明.txt").unwrap(), "/资料/说明.txt");
    }

    #[test]
    fn rejects_empty_and_nul() {
        assert_eq!(code(""), ServerErrorCode::PathInvalid);
        assert_eq!(code("/a\0b"), ServerErrorCode::PathInvalid);
    }

    #[test]
    fn parents() {
        assert_eq!(parent("/").unwrap(), "/");
        assert_eq!(parent("/a").unwrap(), "/");
        assert_eq!(parent("/a/b").unwrap(), "/a");
        assert_eq!(parent("/a/b/").unwrap(), "/a");
        assert_eq!(parent("a").unwrap(), ".");
        assert_eq!(parent("a/b").unwrap(), "a");
        assert_eq!(parent("..").unwrap(), ".");
    }

    #[test]
    fn joins_segments() {
        assert_eq!(join("/", "x").unwrap(), "/x");
        assert_eq!(join("/tmp", "x").unwrap(), "/tmp/x");
        assert_eq!(join("/tmp/", "x").unwrap(), "/tmp/x");
        assert_eq!(join(".", "x").unwrap(), "./x");
        assert_eq!(join("/资料", "说明.txt").unwrap(), "/资料/说明.txt");
    }

    #[test]
    fn rejects_multi_segment_names() {
        assert_eq!(join("/tmp", "").unwrap_err().code, ServerErrorCode::PathInvalid);
        assert_eq!(join("/tmp", "a/b").unwrap_err().code, ServerErrorCode::PathInvalid);
        assert_eq!(join("/tmp", "..").unwrap_err().code, ServerErrorCode::PathInvalid);
        assert_eq!(join("/tmp", ".").unwrap_err().code, ServerErrorCode::PathInvalid);
    }

    #[test]
    fn collision_names() {
        assert_eq!(collision_name("a.txt", 1).unwrap(), "a (1).txt");
        assert_eq!(collision_name("archive.tar.gz", 2).unwrap(), "archive.tar (2).gz");
        assert_eq!(collision_name("a", 1).unwrap(), "a (1)");
        assert_eq!(collision_name(".bashrc", 3).unwrap(), ".bashrc (3)");
        assert_eq!(collision_name("", 1).unwrap_err().code, ServerErrorCode::PathInvalid);
    }

    #[test]
    fn sanitizes_local_names() {
        assert_eq!(sanitize_local_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_local_name("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_local_name("tab\there"), "tab_here");
        assert_eq!(sanitize_local_name("trailing."), "trailing");
        assert_eq!(sanitize_local_name("说明.txt"), "说明.txt");
        assert_eq!(sanitize_local_name(""), "_");
        assert_eq!(sanitize_local_name(".."), "_");
    }
}
