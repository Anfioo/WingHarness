//! Confines a caller-supplied path to a root directory.
//!
//! Every path a frontend hands the backend is untrusted — codelet addresses
//! files with `/`-rooted POSIX strings, and nothing stops a page from sending
//! whatever it likes. Both the notes store and the project working copy resolve
//! through here so one guard covers both.

use std::path::{Component, Path, PathBuf};

/// Resolves a caller-supplied path to an absolute one inside the root.
///
/// Normalizing `a/../b` into `b` is how a guard gets talked past, so a `.` or
/// `..` segment is refused outright rather than resolved, and so is a backslash
/// (a second separator on Windows), a NUL, and a drive letter.
pub fn safe_join(root: &Path, path: &str) -> Result<PathBuf, String> {
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

/// The `/`-rooted POSIX form of a path relative to the root, which is how
/// codelet addresses it. A path outside the root yields nothing usable, so the
/// caller must have checked that first.
pub fn relative_posix(root: &Path, path: &Path) -> String {
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
        let joined = safe_join(&root(), "/a/b.md").unwrap();
        assert_eq!(joined, root().join("a").join("b.md"));
        // A leading slash is how codelet spells a path, so it is optional here.
        assert_eq!(safe_join(&root(), "a/b.md").unwrap(), joined);
    }

    #[test]
    fn refuses_an_escape() {
        for path in ["../secret", "/a/../../b", "/..", "..", "/a/./b", ""] {
            assert!(safe_join(&root(), path).is_err(), "should refuse {path:?}");
        }
    }

    #[test]
    fn refuses_a_backslash_or_drive_letter() {
        for path in ["/a\\b", "/C:/windows", "/a/b:c"] {
            assert!(safe_join(&root(), path).is_err(), "should refuse {path:?}");
        }
    }

    #[test]
    fn relative_posix_joins_with_leading_slash() {
        let r = root();
        assert_eq!(relative_posix(&r, &r.join("a").join("b.md")), "/a/b.md");
        assert_eq!(relative_posix(&r, &r), "");
    }
}
