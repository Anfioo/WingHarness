//! Bounded foreground-usage evidence for installed applications.
//!
//! Only an application identifier, an executable or package path, and a
//! timestamp are stored. Loading is tolerant: an unreadable or unknown-schema
//! document leaves the feature in memory-only mode instead of discarding it.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{SystoolsError, SystoolsResult};
use crate::paths;

const SCHEMA_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 1024;
const MAX_BYTES: u64 = 1024 * 1024;
const RETENTION_MS: u64 = 365 * 24 * 60 * 60 * 1000;
const WRITER_INTERVAL: Duration = Duration::from_secs(30);
const FILE_NAME: &str = "application-usage.json";

static WRITER_RUNNING: AtomicBool = AtomicBool::new(false);
static STORE: OnceLock<Mutex<UsageState>> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    identifier: String,
    path: PathBuf,
    timestamp_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageDocument {
    schema_version: u32,
    observations: Vec<Observation>,
}

#[derive(Default)]
struct UsageState {
    loaded: bool,
    writable: bool,
    revision: u64,
    persisted_revision: u64,
    observations: HashMap<(String, PathBuf), Observation>,
}

/// Application usage evidence. It never records document or window contents.
pub(crate) struct ApplicationUsageService;

/// Owns the background writer. Dropping it flushes once and stops the worker.
pub struct ApplicationUsagePersistence {
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for ApplicationUsagePersistence {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl ApplicationUsageService {
    /// Records one observation. Callbacks only update bounded memory; the
    /// adapter owns the writer lifetime.
    pub(crate) fn observe(identifier: String, path: PathBuf, timestamp_ms: u64) {
        let now = now_millis();
        if !valid(&identifier, &path, timestamp_ms, now) {
            return;
        }
        let Ok(mut state) = store().lock() else {
            return;
        };
        if insert(
            &mut state,
            Observation {
                identifier,
                path,
                timestamp_ms,
            },
        ) {
            state.revision = state.revision.wrapping_add(1);
            prune(&mut state, now);
        }
    }

    /// Starts the single background writer for this process.
    pub fn start_persistence() -> SystoolsResult<ApplicationUsagePersistence> {
        if WRITER_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(SystoolsError::busy("application_usage_writer"));
        }
        let (stop, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("application-usage-writer".into())
            .spawn(move || {
                struct WriterGuard;
                impl Drop for WriterGuard {
                    fn drop(&mut self) {
                        WRITER_RUNNING.store(false, Ordering::Release);
                    }
                }
                let _guard = WriterGuard;
                load();
                loop {
                    let stopping = !matches!(
                        receiver.recv_timeout(WRITER_INTERVAL),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    );
                    flush();
                    if stopping {
                        break;
                    }
                }
            })
            .map_err(|error| {
                WRITER_RUNNING.store(false, Ordering::Release);
                log::warn!("application_usage_writer_start_failed error={error}");
                SystoolsError::operation_failed("application_usage_writer")
            })?;
        Ok(ApplicationUsagePersistence {
            stop,
            worker: Some(worker),
        })
    }

    /// Returns the latest observation timestamp per identifier and path.
    pub(crate) fn dates() -> HashMap<(String, PathBuf), u64> {
        load();
        store()
            .lock()
            .map(|state| {
                state
                    .observations
                    .iter()
                    .map(|(key, value)| (key.clone(), value.timestamp_ms))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Returns the latest observation timestamp per identifier and path.
pub(crate) fn dates() -> HashMap<(String, PathBuf), u64> {
    ApplicationUsageService::dates()
}

fn store() -> &'static Mutex<UsageState> {
    STORE.get_or_init(|| Mutex::new(UsageState::default()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn path() -> Option<PathBuf> {
    paths::dir().ok().map(|directory| directory.join(FILE_NAME))
}

fn valid(identifier: &str, path: &Path, timestamp: u64, now: u64) -> bool {
    !identifier.is_empty()
        && identifier.len() <= 255
        && !identifier.chars().any(char::is_control)
        && path.is_absolute()
        && timestamp > 0
        && timestamp <= now
        && timestamp >= now.saturating_sub(RETENTION_MS)
}

fn insert(state: &mut UsageState, observation: Observation) -> bool {
    let key = (observation.identifier.clone(), observation.path.clone());
    if state
        .observations
        .get(&key)
        .is_some_and(|existing| existing.timestamp_ms >= observation.timestamp_ms)
    {
        return false;
    }
    state.observations.insert(key, observation);
    true
}

fn prune(state: &mut UsageState, now: u64) {
    state
        .observations
        .retain(|_, value| valid(&value.identifier, &value.path, value.timestamp_ms, now));
    while state.observations.len() > MAX_ENTRIES {
        let Some(key) = state
            .observations
            .iter()
            .min_by_key(|(_, value)| value.timestamp_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        state.observations.remove(&key);
    }
}

fn read_document(path: &Path, now: u64) -> Result<Vec<Observation>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
        return Err("unsupported file type or size".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("document exceeds read limit".into());
    }
    let document: UsageDocument =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if document.schema_version != SCHEMA_VERSION || document.observations.len() > MAX_ENTRIES {
        return Err("unsupported application usage schema or entry count".into());
    }
    Ok(document
        .observations
        .into_iter()
        .filter(|value| valid(&value.identifier, &value.path, value.timestamp_ms, now))
        .collect())
}

fn load() {
    if store().lock().map_or(true, |state| state.loaded) {
        return;
    }
    let Some(path) = path() else {
        return;
    };
    // Loading runs in the writer or a scan worker, never in a UI notification.
    let loaded = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        _ => read_document(&path, now_millis()),
    };
    let Ok(mut state) = store().lock() else {
        return;
    };
    if state.loaded {
        return;
    }
    state.loaded = true;
    match loaded {
        Ok(observations) => {
            for observation in observations {
                insert(&mut state, observation);
            }
            prune(&mut state, now_millis());
            state.writable = true;
        }
        Err(error) => log::warn!(
            "application_usage_load_failed path={} stage=read error={} outcome=preserved_read_only",
            path.display(),
            error
        ),
    }
}

fn flush() {
    let Some(path) = path() else {
        return;
    };
    let Some((observations, revision)) = store().lock().ok().and_then(|state| {
        (state.writable && state.revision != state.persisted_revision).then(|| {
            (
                state.observations.values().cloned().collect::<Vec<_>>(),
                state.revision,
            )
        })
    }) else {
        return;
    };
    if let Err(error) = write_document(&path, observations) {
        log::warn!(
            "application_usage_save_failed path={} stage=atomic_replace error={} outcome=memory_retained",
            path.display(),
            error
        );
    } else if let Ok(mut state) = store().lock() {
        state.persisted_revision = revision;
    }
}

fn write_document(path: &Path, observations: Vec<Observation>) -> Result<(), String> {
    let parent = path.parent().ok_or("missing parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(&UsageDocument {
        schema_version: SCHEMA_VERSION,
        observations,
    })
    .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("application usage document exceeds write limit".into());
    }
    let temporary = parent.join(format!(
        ".{FILE_NAME}.{}-{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let written = fs::File::create(&temporary)
        .and_then(|mut file| {
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .and_then(|_| fs::rename(&temporary, path));
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "systools-usage-{name}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&root).expect("the usage fixture should be created");
        root
    }

    #[test]
    fn newer_observations_replace_older_ones_and_paths_stay_separate() {
        let root = temp_root("insert");
        let mut state = UsageState::default();
        let mut item = Observation {
            identifier: "Example.Application".into(),
            path: root.join("first/example.exe"),
            timestamp_ms: 20,
        };
        assert!(insert(&mut state, item.clone()));
        item.timestamp_ms = 10;
        assert!(!insert(&mut state, item.clone()));
        item.path = root.join("second/example.exe");
        assert!(insert(&mut state, item));
        assert_eq!(state.observations.len(), 2);
        fs::remove_dir_all(root).expect("the usage fixture should be removed");
    }

    #[test]
    fn usage_documents_round_trip_and_unknown_schemas_are_rejected() {
        let root = temp_root("document");
        let path = root.join(FILE_NAME);
        let now = now_millis();
        write_document(
            &path,
            vec![Observation {
                identifier: "Example.Application".into(),
                path: root.join(r"Example\example.exe"),
                timestamp_ms: now,
            }],
        )
        .expect("the usage document should be written");
        assert_eq!(read_document(&path, now).expect("the document should load").len(), 1);
        let bytes = br#"{"schemaVersion":99,"observations":[]}"#;
        fs::write(&path, bytes).expect("the fixture should be written");
        assert!(read_document(&path, now).is_err());
        assert_eq!(fs::read(&path).expect("the fixture should be readable"), bytes);
        fs::remove_dir_all(root).expect("the usage fixture should be removed");
    }

    #[test]
    fn observations_require_absolute_paths_and_bounded_timestamps() {
        let root = temp_root("validation");
        let now = now_millis();
        assert!(valid("Example", &root.join("example.exe"), now, now));
        assert!(!valid("", &root.join("example.exe"), now, now));
        assert!(!valid("Example", Path::new("example.exe"), now, now));
        assert!(!valid("Example", &root.join("example.exe"), 0, now));
        assert!(!valid(
            "Example",
            &root.join("example.exe"),
            now.saturating_add(1),
            now
        ));
        fs::remove_dir_all(root).expect("the usage fixture should be removed");
    }
}
