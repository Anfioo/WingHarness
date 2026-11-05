//! Pid records: one per profile under `profiles/<id>/frpc.pid`, written right
//! after a successful spawn and used to reap leftovers from a crashed session.
//!
//! A recorded pid is only killed when the running image still looks like the
//! `frpc` that was launched; a recycled pid must never take an unrelated
//! process down with it.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::proc::hidden;

const PID_FILE_NAME: &str = "frpc.pid";
const KILL_TIMEOUT: Duration = Duration::from_secs(3);
const KILL_STEP: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PidRecord {
    pub profile_id: String,
    pub pid: u32,
    pub config_path: String,
    pub runtime_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct CleanupReport {
    pub scanned: usize,
    /// Profiles whose leftover process was terminated.
    pub terminated: Vec<(String, u32)>,
    /// Records dropped because the process was gone or was not `frpc`.
    pub stale_removed: usize,
}

/// Record the child that is now running for `profile_id`.
pub fn write_pid_record(profile_id: &str, pid: u32, config_path: &Path, runtime_path: &Path) {
    let Ok(directory) = crate::paths::ensure_profile_dir(profile_id) else {
        log::warn!("frp_pid_dir_unavailable profile={profile_id}");
        return;
    };
    let record = PidRecord {
        profile_id: profile_id.to_string(),
        pid,
        config_path: config_path.to_string_lossy().into_owned(),
        runtime_path: runtime_path.to_string_lossy().into_owned(),
    };
    if let Err(error) = write_record_at(&directory.join(PID_FILE_NAME), &record) {
        log::warn!("frp_pid_write_failed profile={profile_id} error={error}");
    }
}

pub fn read_pid_record(profile_id: &str) -> Option<PidRecord> {
    let path = crate::paths::pid_path(profile_id).ok()?;
    read_record_at(&path)
}

pub fn clear_pid_record(profile_id: &str) {
    let Ok(path) = crate::paths::pid_path(profile_id) else {
        return;
    };
    remove_record_at(&path);
}

/// Called once by the root crate at startup: terminate `frpc` processes that an
/// earlier session left behind and drop their pid records.
pub fn cleanup_startup() -> CleanupReport {
    let Ok(root) = crate::paths::profiles_dir() else {
        return CleanupReport::default();
    };
    let report = cleanup_in(&root);
    if !report.terminated.is_empty() || report.stale_removed > 0 {
        log::info!(
            "frp_orphan_cleanup scanned={} terminated={} stale_removed={}",
            report.scanned,
            report.terminated.len(),
            report.stale_removed
        );
    }
    report
}

/// Last resort after `stop`: kill whatever pid this profile still records.
pub fn terminate_recorded_orphan(profile_id: &str) -> bool {
    let Some(record) = read_pid_record(profile_id) else {
        return false;
    };
    let mut killed = false;
    if let Some(image) = process_image_name(record.pid) {
        if looks_like_frpc(&image, &record.runtime_path) {
            killed = terminate_pid(record.pid);
        }
    }
    clear_pid_record(profile_id);
    killed
}

fn cleanup_in(profiles_root: &Path) -> CleanupReport {
    let mut report = CleanupReport::default();
    let Ok(entries) = fs::read_dir(profiles_root) else {
        return report;
    };

    for entry in entries.flatten() {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let path = directory.join(PID_FILE_NAME);
        let Some(record) = read_record_at(&path) else {
            continue;
        };
        report.scanned += 1;

        let Some(image) = process_image_name(record.pid) else {
            remove_record_at(&path);
            report.stale_removed += 1;
            continue;
        };
        if !looks_like_frpc(&image, &record.runtime_path) {
            // The pid now belongs to something else: drop the marker only.
            remove_record_at(&path);
            report.stale_removed += 1;
            continue;
        }
        if terminate_pid(record.pid) {
            report.terminated.push((record.profile_id.clone(), record.pid));
        }
        remove_record_at(&path);
    }

    report
}

fn write_record_at(path: &Path, record: &PidRecord) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_vec_pretty(record)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    fs::write(path, payload)
}

fn read_record_at(path: &Path) -> Option<PidRecord> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn remove_record_at(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("frp_pid_remove_failed path={} error={error}", path.display()),
    }
}

/// Image name of a live pid, or `None` when no such process exists.
fn process_image_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }

    #[cfg(windows)]
    {
        let output = hidden("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines().find_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix('"')?;
            let end = rest.find('"')?;
            Some(rest[..end].to_string())
        })
    }

    #[cfg(unix)]
    {
        let output = hidden("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        None
    }
}

fn looks_like_frpc(image_name: &str, runtime_path: &str) -> bool {
    let image = executable_stem(image_name);
    let expected = Path::new(runtime_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(executable_stem)
        .unwrap_or_default();
    image == "frpc" || (!expected.is_empty() && image == expected)
}

fn executable_stem(name: &str) -> String {
    let name = name.trim().to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    name.to_string()
}

fn terminate_pid(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }

    #[cfg(windows)]
    {
        let _ = hidden("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(unix)]
    let _ = hidden("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    let deadline = Instant::now() + KILL_TIMEOUT;
    while Instant::now() < deadline {
        if process_image_name(pid).is_none() {
            return true;
        }
        std::thread::sleep(KILL_STEP);
    }

    #[cfg(unix)]
    let _ = hidden("kill")
        .args(["-KILL", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    std::thread::sleep(KILL_STEP);
    process_image_name(pid).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "frp-core-orphan-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn record(profile_id: &str, pid: u32) -> PidRecord {
        PidRecord {
            profile_id: profile_id.to_string(),
            pid,
            config_path: format!("profiles/{profile_id}/frpc.toml"),
            runtime_path: "C:/tools/frpc.exe".to_string(),
        }
    }

    #[test]
    fn roundtrips_a_pid_record() {
        let directory = temp_dir("roundtrip");
        let path = directory.join(PID_FILE_NAME);
        let expected = record("p1", 4242);
        write_record_at(&path, &expected).expect("write record");
        assert_eq!(read_record_at(&path), Some(expected));
        remove_record_at(&path);
        assert!(read_record_at(&path).is_none());
    }

    #[test]
    fn cleanup_drops_records_whose_process_is_gone() {
        let root = temp_dir("stale");
        let profile = root.join("dead");
        fs::create_dir_all(&profile).expect("profile dir");
        // A pid that no process owns.
        write_record_at(&profile.join(PID_FILE_NAME), &record("dead", u32::MAX))
            .expect("write record");

        let report = cleanup_in(&root);
        assert_eq!(report.scanned, 1);
        assert_eq!(report.stale_removed, 1);
        assert!(report.terminated.is_empty());
        assert!(!profile.join(PID_FILE_NAME).exists());
    }

    #[test]
    fn cleanup_never_kills_a_non_frpc_process() {
        let root = temp_dir("alive");
        let profile = root.join("alive");
        fs::create_dir_all(&profile).expect("profile dir");
        // Our own test process is alive but is not frpc: the record must be
        // dropped without touching it.
        write_record_at(
            &profile.join(PID_FILE_NAME),
            &record("alive", std::process::id()),
        )
        .expect("write record");

        let report = cleanup_in(&root);
        assert_eq!(report.scanned, 1);
        assert_eq!(report.stale_removed, 1);
        assert!(report.terminated.is_empty());
        assert!(!profile.join(PID_FILE_NAME).exists());
    }

    #[test]
    fn matches_only_frpc_images() {
        assert!(looks_like_frpc("frpc.exe", "C:/tools/frpc.exe"));
        assert!(looks_like_frpc("frpc", "C:/tools/frpc.exe"));
        assert!(looks_like_frpc("my-frpc.exe", "C:/tools/my-frpc.exe"));
        assert!(!looks_like_frpc("java.exe", "C:/tools/frpc.exe"));
        assert!(!looks_like_frpc("", "C:/tools/frpc.exe"));
    }

    #[test]
    fn unreachable_pid_reports_nothing() {
        assert!(process_image_name(0).is_none());
        assert!(process_image_name(u32::MAX).is_none());
    }
}
