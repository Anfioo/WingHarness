//! Confines a caller-supplied path to the working copy root.
//!
//! The frontend addresses files with `/`-rooted POSIX strings and nothing stops
//! a page from sending whatever it likes, so every path crosses this guard
//! before it reaches the filesystem. The rules mirror the app's own
//! `commands::fs_guard`, kept here so the crate stands on its own.

use std::path::{Component, Path, PathBuf};

/// Names never served, at the root only. `.git` carries the whole history in a
/// listing and nothing downstream wants it.
const EXCLUDE: &[&str] = &[".git"];

/// Resolves a caller-supplied path to an absolute one inside the root.
///
/// Normalizing `a/../b` into `b` is how a guard gets talked past, so a `.` or
/// `..` segment is refused outright rather than resolved, and so is a backslash
/// (a second separator on Windows), a NUL, and a drive letter.
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let joined = safe_join(root, path)?;
    if excluded(&relative_posix(root, &joined)) {
        return Err(format!("拒绝访问：{path}"));
    }
    Ok(joined)
}

/// Resolves a path that must stay inside the root, without the exclude rules.
fn safe_join(root: &Path, path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Err("path is empty".into());
    }

    let mut out = root.to_path_buf();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!("invalid path segment in {path:?}"));
        }
        if segment.contains('\\') || segment.contains('\0') || segment.contains(':') {
            return Err(format!("invalid character in path segment {segment:?}"));
        }
        out.push(segment);
    }

    // Belt and braces: the pieces above already rule out an escape, but assert
    // it rather than trust the reasoning.
    if !out.starts_with(root) {
        return Err(format!("path escapes the root: {path:?}"));
    }
    Ok(out)
}

/// Whether a root-relative path names something never served.
///
/// `relative_posix` yields a leading slash, so one is stripped before the
/// comparison; a name only ever matches at the root.
fn excluded(rel: &str) -> bool {
    let rel = rel.trim_start_matches('/');
    EXCLUDE
        .iter()
        .any(|name| rel == *name || rel.starts_with(&format!("{name}/")))
}

/// The `/`-rooted POSIX form of a path relative to the root.
fn relative_posix(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut joined = String::new();
    for component in rel.components() {
        if let Component::Normal(part) = component {
            joined.push('/');
            joined.push_str(&part.to_string_lossy());
        }
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from(r"C:\data\root")
    }

    #[test]
    fn accepts_paths_inside_the_root() {
        let joined = resolve(&root(), "/a/b.md").unwrap();
        assert_eq!(joined, root().join("a").join("b.md"));
        // A leading slash is how the frontend spells a path, so it is optional.
        assert_eq!(resolve(&root(), "a/b.md").unwrap(), joined);
    }

    #[test]
    fn refuses_an_escape() {
        for path in ["../secret", "/a/../../b", "/..", "..", "/a/./b", ""] {
            assert!(resolve(&root(), path).is_err(), "should refuse {path:?}");
        }
    }

    #[test]
    fn refuses_a_backslash_or_drive_letter() {
        for path in ["/a\\b", "/C:/windows", "/a/b:c"] {
            assert!(resolve(&root(), path).is_err(), "should refuse {path:?}");
        }
    }

    #[test]
    fn refuses_dot_git_at_any_depth() {
        for path in [".git", ".git/config", "/.git/objects/ab/cd"] {
            assert!(resolve(&root(), path).is_err(), "should refuse {path:?}");
        }
        assert!(resolve(&root(), ".gitignore").is_ok());
        assert!(resolve(&root(), "src/main.rs").is_ok());
    }
}