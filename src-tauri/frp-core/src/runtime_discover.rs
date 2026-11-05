//! Local `frpc` discovery: the `PATH` directories, the places Windows builds
//! usually land in, and an optional bounded walk of the user's home directory.
//!
//! The scan only produces candidates; nothing is imported here. Every candidate
//! is probed before it is reported, so the UI can show a version next to a path
//! the user has not registered yet.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::models::{DiscoveredRuntime, RuntimeRecord};
use crate::runtimes;
use crate::runtime_probe;

/// A deep scan never descends further than this many directories below the
/// home directory.
pub const MAX_DEPTH: usize = 7;

/// A deep scan stops after this many hits; a large home directory must not turn
/// discovery into a minute-long walk.
pub const MAX_DEEP_HITS: usize = 24;

/// Directories no `frpc` is ever installed in, and the ones whose contents are
/// both huge and irrelevant. Dot directories are skipped separately.
const SKIPPED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "build",
    "dist",
    ".cargo",
    "vendor",
    "Pods",
    "Library",
];

/// Which search produced a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SourceHint {
    Path,
    Common,
    Deep,
}

impl SourceHint {
    /// The label the DTO carries as `source`.
    pub fn label(self) -> &'static str {
        match self {
            SourceHint::Path => "path",
            SourceHint::Common => "common",
            SourceHint::Deep => "deep",
        }
    }
}

/// Find every `frpc` this machine already has.
///
/// `installed` is the current workspace list; records are matched by normalized
/// path first and by content hash second, so a moved or copied binary is still
/// recognized. The result is sorted by version (newest first) and then path.
pub fn discover(installed: &[RuntimeRecord], deep: bool) -> Vec<DiscoveredRuntime> {
    let path_dirs = path_directories();
    let common_dirs = common_directories();

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for directory in &path_dirs {
        push_candidate(&mut candidates, &mut seen, directory.join(frpc_name()));
    }
    for directory in &common_dirs {
        push_candidate(&mut candidates, &mut seen, directory.join(frpc_name()));
    }

    if deep {
        match home_directory() {
            Some(home) if !is_network_path(&home) => {
                for hit in deep_scan(&home) {
                    push_candidate(&mut candidates, &mut seen, hit);
                }
            }
            Some(home) => log::info!(
                "frp_runtime_discover_skipped_network_home path={}",
                home.display()
            ),
            None => log::info!("frp_runtime_discover_no_home_directory"),
        }
    }

    let hashes_known = installed.iter().any(|record| !record.sha256.is_empty());
    let candidate_count = candidates.len();
    let mut results = Vec::new();

    for candidate in candidates {
        let probe = runtime_probe::probe(&candidate.to_string_lossy());
        let usable = probe.version.is_some()
            || probe
                .raw_output
                .as_deref()
                .is_some_and(runtime_probe::looks_like_frpc);
        if !usable {
            continue;
        }

        let key = runtimes::path_key(&candidate);
        let mut matched = installed
            .iter()
            .find(|record| runtimes::path_key(Path::new(&record.path)) == key);

        if matched.is_none() && hashes_known {
            if let Ok((sha256, _)) = runtimes::hash_file(&candidate) {
                matched = installed
                    .iter()
                    .find(|record| !record.sha256.is_empty() && record.sha256 == sha256);
            }
        }

        results.push(DiscoveredRuntime {
            path: runtimes::display_path(&candidate),
            version: probe.version,
            platform: probe.platform,
            architecture: probe.architecture,
            source: classify_source_hint(&path_dirs, &common_dirs, &candidate)
                .label()
                .to_string(),
            already_imported: matched.is_some(),
            runtime_id: matched.map(|record| record.id.clone()),
        });
    }

    results.sort_by(|left, right| {
        runtimes::compare_versions(
            right.version.as_deref().unwrap_or_default(),
            left.version.as_deref().unwrap_or_default(),
        )
        .then_with(|| left.path.cmp(&right.path))
    });

    log::info!(
        "frp_runtime_discover_done deep={deep} candidates={candidate_count} found={}",
        results.len()
    );
    results
}

/// Where a candidate came from.
///
/// A directory that is on `PATH` wins over a well-known install directory, and
/// anything in neither can only have come from the deep scan.
pub fn classify_source_hint(
    path_dirs: &[PathBuf],
    common_dirs: &[PathBuf],
    candidate: &Path,
) -> SourceHint {
    let Some(parent) = candidate.parent() else {
        return SourceHint::Deep;
    };
    let parent_key = runtimes::path_key(parent);

    if path_dirs
        .iter()
        .any(|directory| runtimes::path_key(directory) == parent_key)
    {
        return SourceHint::Path;
    }
    if common_dirs
        .iter()
        .any(|directory| runtimes::path_key(directory) == parent_key)
    {
        return SourceHint::Common;
    }
    SourceHint::Deep
}

/// Whether a directory must not be descended into: dot directories (which holds
/// `.git` and `.cargo` too) and the known heavy build trees.
pub fn should_skip_directory(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    if name.starts_with('.') {
        return true;
    }
    SKIPPED_DIRECTORIES
        .iter()
        .any(|skipped| name.eq_ignore_ascii_case(skipped))
}

fn push_candidate(
    candidates: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
    path: PathBuf,
) {
    if !path.is_file() {
        return;
    }
    if seen.insert(runtimes::path_key(&path)) {
        candidates.push(path);
    }
}

fn deep_scan(root: &Path) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    let mut visited = HashSet::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);

    while let Some((directory, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if hits.len() >= MAX_DEEP_HITS {
                return hits;
            }

            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Never follow a symlinked or reparse-point directory: it can point
            // anywhere, including off this machine.
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            if file_type.is_dir() {
                if depth >= MAX_DEPTH || should_skip_directory(&path) {
                    continue;
                }
                if visited.insert(runtimes::path_key(&path)) {
                    queue.push_back((path, depth + 1));
                }
            } else if file_type.is_file() && is_frpc_name(&path) {
                hits.push(path);
            }
        }
    }

    hits
}

fn is_frpc_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name.eq_ignore_ascii_case("frpc.exe") || name.eq_ignore_ascii_case("frpc")
}

fn frpc_name() -> &'static str {
    if cfg!(windows) {
        "frpc.exe"
    } else {
        "frpc"
    }
}

fn path_directories() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn common_directories() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        windows_common_directories()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn windows_common_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for (variable, suffix) in [
        ("LOCALAPPDATA", "frp"),
        ("LOCALAPPDATA", r"Programs\frp"),
        ("ProgramFiles", "frp"),
        ("ProgramFiles", "frpc"),
        // Chocolatey installs a `frpc.exe` shim here.
        ("ProgramData", r"chocolatey\bin"),
    ] {
        if let Some(base) = std::env::var_os(variable) {
            directories.push(PathBuf::from(base).join(suffix));
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let profile = PathBuf::from(profile);
        directories.push(profile.join(r"scoop\shims"));
        directories.push(profile.join(r"scoop\apps\frp\current"));
    }
    directories
}

fn home_directory() -> Option<PathBuf> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

/// Network drives and UNC shares are never scanned: discovery would stall on a
/// disconnected drive.
fn is_network_path(path: &Path) -> bool {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy().replace('/', "\\");
    text.starts_with(r"\\?\UNC\") || (text.starts_with(r"\\") && !text.starts_with(r"\\?\"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_support::scratch;

    fn binary(directory: &Path) -> PathBuf {
        std::fs::create_dir_all(directory).expect("create directory");
        let path = directory.join(frpc_name());
        std::fs::write(&path, b"fake frpc binary").expect("write fake binary");
        path
    }

    #[test]
    fn classifies_each_scan_bucket() {
        let root = scratch("discover-classify");
        let on_path = root.join("on-path");
        let common = root.join("common");
        let elsewhere = root.join("elsewhere");

        let path_binary = binary(&on_path);
        let common_binary = binary(&common);
        let deep_binary = binary(&elsewhere);

        let path_dirs = vec![on_path.clone()];
        let common_dirs = vec![common.clone()];

        assert_eq!(
            classify_source_hint(&path_dirs, &common_dirs, &path_binary),
            SourceHint::Path
        );
        assert_eq!(
            classify_source_hint(&path_dirs, &common_dirs, &common_binary),
            SourceHint::Common
        );
        assert_eq!(
            classify_source_hint(&path_dirs, &common_dirs, &deep_binary),
            SourceHint::Deep
        );
    }

    #[test]
    fn a_path_directory_wins_over_a_common_directory() {
        let root = scratch("discover-precedence");
        let shared = root.join("shared");
        let candidate = binary(&shared);

        assert_eq!(
            classify_source_hint(&[shared.clone()], &[shared], &candidate),
            SourceHint::Path
        );
    }

    #[test]
    fn skipped_directories_cover_dot_and_build_trees() {
        for name in [
            "node_modules",
            ".git",
            "target",
            "build",
            "dist",
            ".cargo",
            "vendor",
            "Pods",
            "Library",
            ".config",
            ".anything",
        ] {
            assert!(
                should_skip_directory(Path::new(name)),
                "{name} must be skipped"
            );
        }
        for name in ["frp", "tools", "Programs", "frpc-0.69.0"] {
            assert!(
                !should_skip_directory(Path::new(name)),
                "{name} must be scanned"
            );
        }
        assert!(!should_skip_directory(Path::new(r"C:\Program Files\FRP")));
        assert!(should_skip_directory(Path::new(r"C:\x\NODE_MODULES")));
    }

    #[cfg(windows)]
    #[test]
    fn candidates_are_deduplicated_ignoring_case() {
        let root = scratch("discover-dedupe");
        let candidate = binary(&root);
        let upper = PathBuf::from(runtimes::display_path(&candidate).to_ascii_uppercase());

        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_candidate(&mut candidates, &mut seen, candidate.clone());
        push_candidate(&mut candidates, &mut seen, upper);

        assert_eq!(candidates.len(), 1, "one file is one candidate");
    }

    #[test]
    fn candidates_must_exist_as_files() {
        let root = scratch("discover-missing");
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_candidate(&mut candidates, &mut seen, root.join("frpc.exe"));
        push_candidate(&mut candidates, &mut seen, root.clone());

        assert!(candidates.is_empty());
    }

    #[test]
    fn network_homes_are_skipped() {
        assert!(is_network_path(Path::new(r"\\server\share\frpc")));
        assert!(is_network_path(Path::new(r"\\?\UNC\server\share")));
        assert!(!is_network_path(&std::env::temp_dir()));
    }

    /// Scans this machine for real; run with `--ignored`.
    #[test]
    #[ignore]
    fn discovers_this_machine() {
        let found = discover(&[], false);
        for runtime in &found {
            println!(
                "{} {} {} imported={}",
                runtime.path,
                runtime.version.as_deref().unwrap_or("unknown"),
                runtime.source,
                runtime.already_imported
            );
        }
    }
}
