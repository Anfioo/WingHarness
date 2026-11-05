//! Runtime records: listing, import/re-probe, delete protection and the rule a
//! profile uses to pick the binary it runs.
//!
//! A record points at a binary the user already has. This module never
//! downloads, moves or deletes anything outside `frp.json`: the file itself
//! belongs to the user and stays untouched even when its record is removed.

use std::cmp::Ordering;
use std::io::Read as _;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::{FrpError, FrpResult};
use crate::models::{FrpProfile, RuntimePolicy, RuntimeProbe, RuntimeRecord, RuntimeView, Workspace};
use crate::runtime_probe;
use crate::store::unix_now;

/// Recorded when the banner could not be parsed but the output mentions frp.
pub const UNKNOWN_VERSION: &str = "unknown";

/// Records in stored order, each with its reference count and live-process flag.
///
/// `is_running` is answered by the process registry; keeping it as a parameter
/// is what lets this module stay free of process state.
pub fn list(workspace: &Workspace, is_running: impl Fn(&str) -> bool) -> Vec<RuntimeView> {
    workspace
        .runtimes
        .iter()
        .map(|record| RuntimeView {
            runtime: record.clone(),
            profile_count: referenced_by(workspace, &record.id),
            in_use: is_running(&record.id),
        })
        .collect()
}

pub fn get<'a>(workspace: &'a Workspace, id: &str) -> FrpResult<&'a RuntimeRecord> {
    workspace
        .runtimes
        .iter()
        .find(|record| record.id == id)
        .ok_or_else(|| FrpError::not_found("runtime", id))
}

/// How many profiles bind this runtime.
pub fn referenced_by(workspace: &Workspace, id: &str) -> u32 {
    workspace
        .profiles
        .iter()
        .filter(|profile| profile.runtime_id.as_deref() == Some(id))
        .count() as u32
}

/// Store the probe result for `requested`.
///
/// The same file imported again is not a duplicate: the normalized path is the
/// identity, so a re-probe updates the existing record in place and keeps its
/// `id` and `addedAt`. Nothing is written to disk here — the caller persists the
/// workspace.
pub fn import(
    workspace: &mut Workspace,
    requested: &Path,
    probe: &RuntimeProbe,
) -> FrpResult<RuntimeRecord> {
    if !requested.is_file() {
        return Err(FrpError::invalid_input(
            "path",
            "The selected path is not a file.",
        ));
    }

    if !probe.valid {
        let output = probe.raw_output.as_deref().unwrap_or_default();
        if !runtime_probe::looks_like_frpc(output) {
            return Err(FrpError::invalid_input(
                "path",
                probe
                    .error
                    .clone()
                    .unwrap_or_else(|| "The selected file does not look like frpc.".to_string()),
            ));
        }
    }

    let version = probe
        .version
        .clone()
        .unwrap_or_else(|| UNKNOWN_VERSION.to_string());
    let platform = probe
        .platform
        .clone()
        .unwrap_or_else(|| runtime_probe::platform().to_string());
    let architecture = probe
        .architecture
        .clone()
        .unwrap_or_else(|| runtime_probe::architecture().to_string());
    let raw_version_output = probe.raw_output.clone().unwrap_or_default();

    let path = display_path(requested);
    let key = path_key(requested);
    let (sha256, size_bytes) = hash_file(requested)?;
    let now = unix_now();

    let record = match workspace
        .runtimes
        .iter_mut()
        .find(|record| path_key(Path::new(&record.path)) == key)
    {
        Some(existing) => {
            existing.path = path;
            existing.version = version;
            existing.platform = platform;
            existing.architecture = architecture;
            existing.sha256 = sha256;
            existing.size_bytes = size_bytes;
            existing.raw_version_output = raw_version_output;
            existing.last_checked_at = Some(now);
            log::info!("frp_runtime_reprobed id={}", existing.id);
            existing.clone()
        }
        None => {
            let record = RuntimeRecord {
                id: uuid::Uuid::new_v4().to_string(),
                path,
                version,
                platform,
                architecture,
                sha256,
                size_bytes,
                raw_version_output,
                added_at: now,
                last_checked_at: Some(now),
            };
            workspace.runtimes.push(record.clone());
            log::info!("frp_runtime_imported id={} path={}", record.id, record.path);
            record
        }
    };

    Ok(record)
}

/// Drop one record. Refuses while a profile still binds it or a live process
/// runs it; the binary on disk is never removed.
pub fn delete(
    workspace: &mut Workspace,
    id: &str,
    is_running: impl Fn(&str) -> bool,
) -> FrpResult<()> {
    let index = workspace
        .runtimes
        .iter()
        .position(|record| record.id == id)
        .ok_or_else(|| FrpError::not_found("runtime", id))?;

    if referenced_by(workspace, id) > 0 || is_running(id) {
        return Err(FrpError::runtime_in_use(id));
    }

    workspace.runtimes.remove(index);
    log::info!("frp_runtime_deleted id={id}");
    Ok(())
}

/// The binary a profile would run.
///
/// A pinned profile must name a record that still exists on disk. A recommended
/// profile prefers its binding, then the newest record for this platform and
/// architecture; with none left it reports `runtime-missing`.
pub fn resolve_for_profile(
    profile: &FrpProfile,
    workspace: &Workspace,
) -> FrpResult<RuntimeRecord> {
    let bound = profile
        .runtime_id
        .as_deref()
        .and_then(|id| workspace.runtimes.iter().find(|record| record.id == id))
        .filter(|record| Path::new(&record.path).is_file());

    if profile.runtime_policy == RuntimePolicy::Pinned {
        if profile.runtime_id.is_none() {
            return Err(FrpError::runtime_missing(
                "This profile must pin an frpc runtime.",
            ));
        }
        return bound.cloned().ok_or_else(|| {
            FrpError::runtime_missing("The runtime pinned by this profile is missing.")
        });
    }

    if let Some(record) = bound {
        return Ok(record.clone());
    }

    let platform = runtime_probe::platform();
    let architecture = runtime_probe::architecture();
    workspace
        .runtimes
        .iter()
        .filter(|record| record.platform == platform && record.architecture == architecture)
        .filter(|record| Path::new(&record.path).is_file())
        .max_by(|left, right| {
            compare_versions(&left.version, &right.version)
                .then_with(|| left.added_at.cmp(&right.added_at))
        })
        .cloned()
        .ok_or_else(|| {
            FrpError::runtime_missing(format!(
                "No frpc runtime is installed for {platform} {architecture}."
            ))
        })
}

/// Compare two version strings segment by segment, numerically where a segment
/// starts with digits. A version with no numeric segment at all (`unknown`)
/// ranks below every parseable one, which lets callers fall back to `addedAt`.
pub(crate) fn compare_versions(left: &str, right: &str) -> Ordering {
    match (version_key(left), version_key(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

/// `None` when no segment starts with a digit — `unknown`, an empty string or
/// hand-edited junk.
fn version_key(version: &str) -> Option<Vec<(u64, String)>> {
    let trimmed = version.trim();
    let body = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);

    let mut key = Vec::new();
    let mut has_number = false;
    for segment in body.split('.') {
        let digits: String = segment
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        let number = digits.parse::<u64>().ok();
        has_number |= number.is_some();
        key.push((number.unwrap_or(0), segment.to_string()));
    }
    has_number.then_some(key)
}

/// The absolute, display-ready form of a path: `\\?\` is stripped and forward
/// slashes become backslashes on Windows. Falls back to the given text when the
/// filesystem cannot resolve it (for example after the file was deleted).
pub fn display_path(path: &Path) -> String {
    match std::fs::canonicalize(path) {
        Ok(resolved) => normalized_text(&resolved),
        Err(_) => normalized_text(path),
    }
}

/// The identity used for deduplication: [`display_path`], lowercased on
/// Windows so `D:\tools\frpc.exe` and `d:\tools\FRPC.EXE` match.
pub fn path_key(path: &Path) -> String {
    let text = display_path(path);
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

/// SHA-256 and size of a file, read in chunks so a large `frpc` never lands in
/// memory in one piece.
pub(crate) fn hash_file(path: &Path) -> FrpResult<(String, u64)> {
    let mut file = std::fs::File::open(path).map_err(|error| {
        log::warn!(
            "frp_runtime_open_failed path={} error={error}",
            path.display()
        );
        FrpError::invalid_input("path", "The selected file could not be read.")
    })?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size_bytes = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            log::warn!(
                "frp_runtime_read_failed path={} error={error}",
                path.display()
            );
            FrpError::internal("The selected file could not be read.")
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size_bytes += read as u64;
    }

    Ok((hex::encode(hasher.finalize()), size_bytes))
}

#[cfg(windows)]
fn normalized_text(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text
            .strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or(text),
    }
}

#[cfg(not(windows))]
fn normalized_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_support::scratch;

    fn profile(id: &str, policy: RuntimePolicy, runtime_id: Option<&str>) -> FrpProfile {
        FrpProfile {
            id: id.to_string(),
            name: format!("profile-{id}"),
            server_addr: "frps.example.com".to_string(),
            server_port: 7000,
            token: None,
            runtime_policy: policy,
            runtime_id: runtime_id.map(str::to_string),
            reconnect_enabled: true,
            note: String::new(),
            config_revision: 0,
            sort_order: 0,
            created_at: 10,
            updated_at: 10,
        }
    }

    fn runtime_record(id: &str, path: &Path, version: &str, added_at: i64) -> RuntimeRecord {
        RuntimeRecord {
            id: id.to_string(),
            path: display_path(path),
            version: version.to_string(),
            platform: runtime_probe::platform().to_string(),
            architecture: runtime_probe::architecture().to_string(),
            sha256: String::new(),
            size_bytes: 0,
            raw_version_output: format!("frpc version {version}"),
            added_at,
            last_checked_at: None,
        }
    }

    fn probe_result(path: &Path, version: Option<&str>) -> RuntimeProbe {
        RuntimeProbe {
            path: display_path(path),
            valid: version.is_some(),
            version: version.map(str::to_string),
            platform: Some(runtime_probe::platform().to_string()),
            architecture: Some(runtime_probe::architecture().to_string()),
            raw_output: Some(
                version
                    .map(|version| format!("frpc version {version}"))
                    .unwrap_or_else(|| "frpc: something odd".to_string()),
            ),
            error: version.is_none().then(|| "No version could be parsed.".to_string()),
        }
    }

    fn binary(directory: &Path, name: &str) -> std::path::PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, b"fake frpc binary").expect("write fake binary");
        path
    }

    #[test]
    fn import_records_every_field() {
        let directory = scratch("runtime-import");
        let path = binary(&directory, "frpc.exe");

        let mut workspace = Workspace::default();
        let record = import(&mut workspace, &path, &probe_result(&path, Some("0.69.0")))
            .expect("import");

        assert_eq!(workspace.runtimes.len(), 1);
        assert_eq!(record.version, "0.69.0");
        assert_eq!(record.path, display_path(&path));
        assert_eq!(
            record.platform.as_str(),
            runtime_probe::platform()
        );
        assert_eq!(record.size_bytes, b"fake frpc binary".len() as u64);
        assert_eq!(record.sha256.len(), 64);
        assert!(record.last_checked_at.is_some());
        assert!(record.added_at > 0);
    }

    #[test]
    fn reimporting_the_same_path_updates_in_place() {
        let directory = scratch("runtime-reimport");
        let path = binary(&directory, "frpc.exe");

        let mut workspace = Workspace::default();
        let first = import(&mut workspace, &path, &probe_result(&path, Some("0.68.1")))
            .expect("first import");
        let second = import(&mut workspace, &path, &probe_result(&path, Some("0.70.1")))
            .expect("second import");

        assert_eq!(workspace.runtimes.len(), 1, "no duplicate record");
        assert_eq!(first.id, second.id, "the id survives a re-probe");
        assert_eq!(second.version, "0.70.1");
        assert_eq!(second.added_at, first.added_at);
    }

    #[cfg(windows)]
    #[test]
    fn path_identity_ignores_case_on_windows() {
        let directory = scratch("runtime-case");
        let path = binary(&directory, "frpc.exe");
        let upper = display_path(&path).to_ascii_uppercase();
        assert_eq!(path_key(&path), path_key(Path::new(&upper)));
    }

    #[test]
    fn import_keeps_a_build_with_an_unparseable_banner() {
        let directory = scratch("runtime-unknown");
        let path = binary(&directory, "frpc.exe");

        let mut workspace = Workspace::default();
        let record = import(&mut workspace, &path, &probe_result(&path, None)).expect("import");
        assert_eq!(record.version, UNKNOWN_VERSION);
    }

    #[test]
    fn import_rejects_a_file_that_does_not_look_like_frpc() {
        let directory = scratch("runtime-not-frpc");
        let path = binary(&directory, "nope.exe");
        let mut probe = probe_result(&path, None);
        probe.raw_output = Some("nginx: unrecognized option".to_string());

        let mut workspace = Workspace::default();
        let error = import(&mut workspace, &path, &probe).expect_err("must reject");
        assert_eq!(error.code, crate::error::FrpErrorCode::InvalidInput);
        assert!(workspace.runtimes.is_empty());
    }

    #[test]
    fn import_rejects_a_missing_file() {
        let directory = scratch("runtime-missing");
        let path = directory.join("frpc.exe");
        let mut workspace = Workspace::default();
        let error = import(&mut workspace, &path, &probe_result(&path, Some("0.69.0")))
            .expect_err("must reject");
        assert_eq!(error.code, crate::error::FrpErrorCode::InvalidInput);
    }

    #[test]
    fn delete_removes_the_record_but_never_the_binary() {
        let directory = scratch("runtime-delete");
        let path = binary(&directory, "frpc.exe");

        let mut workspace = Workspace::default();
        import(&mut workspace, &path, &probe_result(&path, Some("0.69.0"))).expect("import");
        let id = workspace.runtimes[0].id.clone();

        delete(&mut workspace, &id, |_| false).expect("delete");
        assert!(workspace.runtimes.is_empty());
        assert!(path.is_file(), "the external binary is untouched");
    }

    #[test]
    fn delete_refuses_a_referenced_runtime() {
        let directory = scratch("runtime-referenced");
        let path = binary(&directory, "frpc.exe");
        let mut workspace = Workspace::default();
        let record =
            import(&mut workspace, &path, &probe_result(&path, Some("0.69.0"))).expect("import");
        workspace
            .profiles
            .push(profile("p1", RuntimePolicy::Pinned, Some(&record.id)));

        let error = delete(&mut workspace, &record.id, |_| false).expect_err("must refuse");
        assert_eq!(error.code, crate::error::FrpErrorCode::RuntimeInUse);
        assert_eq!(workspace.runtimes.len(), 1);
    }

    #[test]
    fn delete_refuses_a_running_runtime() {
        let directory = scratch("runtime-running");
        let path = binary(&directory, "frpc.exe");
        let mut workspace = Workspace::default();
        let record =
            import(&mut workspace, &path, &probe_result(&path, Some("0.69.0"))).expect("import");

        let error = delete(&mut workspace, &record.id, |id| id == record.id).expect_err("must refuse");
        assert_eq!(error.code, crate::error::FrpErrorCode::RuntimeInUse);
        assert_eq!(workspace.runtimes.len(), 1);
    }

    #[test]
    fn delete_reports_a_missing_record() {
        let mut workspace = Workspace::default();
        let error = delete(&mut workspace, "nope", |_| false).expect_err("must fail");
        assert_eq!(error.code, crate::error::FrpErrorCode::NotFound);
    }

    #[test]
    fn list_reports_references_and_live_use() {
        let directory = scratch("runtime-list");
        let path = binary(&directory, "frpc.exe");
        let mut workspace = Workspace::default();
        let record =
            import(&mut workspace, &path, &probe_result(&path, Some("0.69.0"))).expect("import");
        workspace
            .profiles
            .push(profile("p1", RuntimePolicy::Recommended, Some(&record.id)));
        workspace
            .profiles
            .push(profile("p2", RuntimePolicy::Pinned, Some(&record.id)));

        let views = list(&workspace, |id| id == record.id);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].profile_count, 2);
        assert!(views[0].in_use);
    }

    #[test]
    fn pinned_requires_a_record_and_a_file() {
        let mut workspace = Workspace::default();
        let unbound = profile("p1", RuntimePolicy::Pinned, None);
        assert_eq!(
            resolve_for_profile(&unbound, &workspace).expect_err("must fail").code,
            crate::error::FrpErrorCode::RuntimeMissing
        );

        let directory = scratch("runtime-pinned");
        let path = binary(&directory, "frpc.exe");
        let record =
            import(&mut workspace, &path, &probe_result(&path, Some("0.69.0"))).expect("import");
        let bound = profile("p2", RuntimePolicy::Pinned, Some(&record.id));
        assert_eq!(
            resolve_for_profile(&bound, &workspace).expect("resolve").id,
            record.id
        );

        std::fs::remove_file(&path).expect("remove binary");
        assert_eq!(
            resolve_for_profile(&bound, &workspace).expect_err("must fail").code,
            crate::error::FrpErrorCode::RuntimeMissing
        );
    }

    #[test]
    fn recommended_prefers_its_binding() {
        let directory = scratch("runtime-bound");
        let first = binary(&directory, "frpc-old.exe");
        let second = binary(&directory, "frpc-new.exe");
        let mut workspace = Workspace::default();
        let old = import(
            &mut workspace,
            &first,
            &probe_result(&first, Some("0.60.0")),
        )
        .expect("import");
        import(
            &mut workspace,
            &second,
            &probe_result(&second, Some("0.70.0")),
        )
        .expect("import");

        let bound = profile("p1", RuntimePolicy::Recommended, Some(&old.id));
        assert_eq!(resolve_for_profile(&bound, &workspace).expect("resolve").id, old.id);
    }

    #[test]
    fn recommended_falls_back_to_the_newest_version() {
        let directory = scratch("runtime-newest");
        let mut workspace = Workspace::default();
        for (name, version, added_at) in [
            ("frpc-a.exe", "0.60.0", 100),
            ("frpc-b.exe", "0.70.1", 50),
            ("frpc-c.exe", "0.68.1-custom", 30),
        ] {
            let path = binary(&directory, name);
            workspace
                .runtimes
                .push(runtime_record(name, &path, version, added_at));
        }

        let unbound = profile("p1", RuntimePolicy::Recommended, None);
        let resolved = resolve_for_profile(&unbound, &workspace).expect("resolve");
        assert_eq!(resolved.version, "0.70.1");
    }

    #[test]
    fn recommended_falls_back_to_added_order_for_unknown_versions() {
        let directory = scratch("runtime-unknown-order");
        let older = binary(&directory, "frpc-old.exe");
        let newer = binary(&directory, "frpc-new.exe");
        let mut workspace = Workspace::default();
        workspace
            .runtimes
            .push(runtime_record("old", &older, UNKNOWN_VERSION, 100));
        workspace
            .runtimes
            .push(runtime_record("new", &newer, UNKNOWN_VERSION, 200));

        let unbound = profile("p1", RuntimePolicy::Recommended, None);
        assert_eq!(
            resolve_for_profile(&unbound, &workspace).expect("resolve").id,
            "new"
        );
    }

    #[test]
    fn recommended_without_any_runtime_reports_missing() {
        let workspace = Workspace::default();
        let unbound = profile("p1", RuntimePolicy::Recommended, None);
        assert_eq!(
            resolve_for_profile(&unbound, &workspace).expect_err("must fail").code,
            crate::error::FrpErrorCode::RuntimeMissing
        );
    }

    #[test]
    fn recommended_ignores_records_for_another_platform() {
        let directory = scratch("runtime-platform");
        let path = binary(&directory, "frpc.exe");
        let mut workspace = Workspace::default();
        let mut record = runtime_record("foreign", &path, "0.99.0", 100);
        record.platform = "plan9".to_string();
        workspace.runtimes.push(record);

        let unbound = profile("p1", RuntimePolicy::Recommended, None);
        assert_eq!(
            resolve_for_profile(&unbound, &workspace).expect_err("must fail").code,
            crate::error::FrpErrorCode::RuntimeMissing
        );
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(compare_versions("0.69.0", "0.70.1"), Ordering::Less);
        assert_eq!(compare_versions("0.70.0", "0.70.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.10.0", "0.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("v0.69.0", "0.69.0"), Ordering::Equal);
        assert_eq!(
            compare_versions("0.68.1-custom", "0.68.1"),
            Ordering::Greater
        );
    }

    #[test]
    fn unknown_versions_rank_below_known_ones() {
        assert_eq!(compare_versions(UNKNOWN_VERSION, "0.1.0"), Ordering::Less);
        assert_eq!(compare_versions("0.1.0", UNKNOWN_VERSION), Ordering::Greater);
        assert_eq!(
            compare_versions(UNKNOWN_VERSION, UNKNOWN_VERSION),
            Ordering::Equal
        );
    }
}
