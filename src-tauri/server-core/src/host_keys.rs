//! Trusted host keys, stored per profile in `known_hosts.json`.
//!
//! A missing record is `Unknown`; a matching fingerprint is `Trusted`; a
//! different key is always `Mismatch` — `trustHostKey` cannot overwrite an
//! existing record, the user has to forget it first.
//!
//! A rejected first contact leaves the presented key in a process-local
//! "pending" slot so `server_host_key_trust_pending` can write the record
//! without the frontend having to send the algorithm back.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::error::{ServerError, ServerResult};
use crate::models::HostKeyRecord;
use crate::paths;
use crate::store::{self, unix_now};

const VERSION: u32 = 1;
const KNOWN_HOSTS_FILE: &str = "known_hosts.json";

/// What should happen when a host presents its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Unknown,
    Trusted,
    Mismatch { trusted: String, presented: String },
}

/// Compare a stored record with the fingerprint the host just presented.
pub(crate) fn evaluate(record: Option<&HostKeyRecord>, presented: &str) -> HostKeyVerdict {
    match record {
        None => HostKeyVerdict::Unknown,
        Some(record) if record.fingerprint == presented => HostKeyVerdict::Trusted,
        Some(record) => HostKeyVerdict::Mismatch {
            trusted: record.fingerprint.clone(),
            presented: presented.to_string(),
        },
    }
}

/// A key the user has not confirmed yet, kept between the failed connect and
/// the confirmation round trip.
#[derive(Debug, Clone)]
struct PendingKey {
    fingerprint: String,
    algorithm: String,
    host: String,
    port: u16,
}

static PENDING: OnceLock<Mutex<HashMap<String, PendingKey>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, PendingKey>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_map() -> std::sync::MutexGuard<'static, HashMap<String, PendingKey>> {
    pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Remember a key that was rejected because it is not trusted yet.
pub(crate) fn remember_pending(
    profile_id: &str,
    fingerprint: &str,
    algorithm: &str,
    host: &str,
    port: u16,
) {
    pending_map().insert(
        profile_id.to_string(),
        PendingKey {
            fingerprint: fingerprint.to_string(),
            algorithm: algorithm.to_string(),
            host: host.to_string(),
            port,
        },
    );
}

pub(crate) fn clear_pending(profile_id: &str) {
    pending_map().remove(profile_id);
}

/// The trusted record of one profile.
pub fn get(profile_id: &str) -> ServerResult<Option<HostKeyRecord>> {
    HostKeyStore::open()?.get(profile_id)
}

/// Drop the trusted record of one profile (the "forget host key" action).
pub fn forget(profile_id: &str) -> ServerResult<()> {
    clear_pending(profile_id);
    HostKeyStore::open()?.forget(profile_id)
}

/// Write the record captured during the `host-key-unknown` round trip.
pub fn trust_pending(profile_id: &str, fingerprint: &str) -> ServerResult<()> {
    HostKeyStore::open()?.trust_pending(profile_id, fingerprint)
}

/// Trust a key straight away; used after a connect that already carried
/// `trustHostKey = true` and passed authentication.
pub(crate) fn record_trusted(
    profile_id: &str,
    algorithm: &str,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> ServerResult<HostKeyRecord> {
    HostKeyStore::open()?.record(profile_id, algorithm, host, port, fingerprint)
}

#[derive(Debug)]
struct KnownHostsFile {
    records: HashMap<String, HostKeyRecord>,
}

impl Default for KnownHostsFile {
    fn default() -> Self {
        Self {
            records: HashMap::new(),
        }
    }
}

/// The store of `known_hosts.json`, rooted at the server data directory.
///
/// The root is a field so tests can use a scratch directory; production code
/// goes through the free functions above.
#[derive(Debug)]
pub(crate) struct HostKeyStore {
    root: PathBuf,
}

impl HostKeyStore {
    fn open() -> ServerResult<Self> {
        Ok(Self {
            root: paths::dir()?.clone(),
        })
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self) -> PathBuf {
        self.root.join(KNOWN_HOSTS_FILE)
    }

    pub(crate) fn get(&self, profile_id: &str) -> ServerResult<Option<HostKeyRecord>> {
        Ok(self.read().records.get(profile_id).cloned())
    }

    pub(crate) fn forget(&self, profile_id: &str) -> ServerResult<()> {
        self.mutate(|file| {
            file.records.remove(profile_id);
            Ok(())
        })
    }

    pub(crate) fn trust_pending(
        &self,
        profile_id: &str,
        fingerprint: &str,
    ) -> ServerResult<()> {
        let pending = pending_map().get(profile_id).cloned().ok_or_else(|| {
            ServerError::internal("No host key is waiting for confirmation.")
        })?;
        if pending.fingerprint != fingerprint {
            return Err(ServerError::internal(
                "The confirmed fingerprint does not match the one that was presented.",
            ));
        }

        let existing = self.get(profile_id)?;
        match evaluate(existing.as_ref(), fingerprint) {
            HostKeyVerdict::Trusted => {
                clear_pending(profile_id);
                return Ok(());
            }
            HostKeyVerdict::Mismatch { trusted, presented } => {
                return Err(ServerError::host_key_mismatch(&trusted, &presented));
            }
            HostKeyVerdict::Unknown => {}
        }

        self.record(
            profile_id,
            &pending.algorithm,
            &pending.host,
            pending.port,
            fingerprint,
        )?;
        clear_pending(profile_id);
        Ok(())
    }

    pub(crate) fn record(
        &self,
        profile_id: &str,
        algorithm: &str,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> ServerResult<HostKeyRecord> {
        let record = HostKeyRecord {
            fingerprint: fingerprint.to_string(),
            algorithm: algorithm.to_string(),
            host: host.to_string(),
            port,
            trusted_at: unix_now(),
        };
        let stored = record.clone();
        self.mutate(|file| {
            file.records.insert(profile_id.to_string(), stored);
            Ok(())
        })?;
        clear_pending(profile_id);
        Ok(record)
    }

    fn mutate<T>(
        &self,
        apply: impl FnOnce(&mut KnownHostsFile) -> ServerResult<T>,
    ) -> ServerResult<T> {
        let _guard = store::lock_for_write()?;
        let mut file = self.read();
        let value = apply(&mut file)?;
        self.write(&file)?;
        Ok(value)
    }

    fn read(&self) -> KnownHostsFile {
        let path = self.path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return KnownHostsFile::default()
            }
            Err(error) => {
                log::warn!(
                    "server_host_keys_read_failed path={} error={error}",
                    path.display()
                );
                return KnownHostsFile::default();
            }
        };

        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => {
                log::warn!(
                    "server_host_keys_parse_failed path={} error={error}",
                    path.display()
                );
                store::backup(&path, KNOWN_HOSTS_FILE);
                return KnownHostsFile::default();
            }
        };

        KnownHostsFile::from_value(&value)
    }

    fn write(&self, file: &KnownHostsFile) -> ServerResult<()> {
        let payload = KnownHostsPayload {
            version: VERSION,
            records: &file.records,
        };
        store::write_json_atomic(&self.path(), &payload).map_err(|error| {
            log::warn!("server_host_keys_write_failed error={error}");
            ServerError::internal("The trusted host keys could not be saved.")
        })
    }
}

#[derive(Serialize)]
struct KnownHostsPayload<'a> {
    version: u32,
    records: &'a HashMap<String, HostKeyRecord>,
}

impl KnownHostsFile {
    fn from_value(value: &serde_json::Value) -> Self {
        let mut file = KnownHostsFile::default();
        if let Some(records) = value.get("records").and_then(|records| records.as_object()) {
            for (profile_id, raw) in records {
                match serde_json::from_value::<HostKeyRecord>(raw.clone()) {
                    Ok(record) => {
                        file.records.insert(profile_id.clone(), record);
                    }
                    Err(error) => {
                        log::warn!("server_host_keys_record_invalid profile={profile_id} error={error}")
                    }
                }
            }
        }
        file
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "server-core-hostkeys-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).expect("scratch directory");
            Self(root)
        }

        fn store(&self) -> HostKeyStore {
            HostKeyStore::at(self.0.clone())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn record(fingerprint: &str) -> HostKeyRecord {
        HostKeyRecord {
            fingerprint: fingerprint.to_string(),
            algorithm: "ssh-ed25519".to_string(),
            host: "10.0.0.12".to_string(),
            port: 22,
            trusted_at: 1,
        }
    }

    #[test]
    fn evaluate_covers_the_three_verdicts() {
        assert_eq!(evaluate(None, "SHA256:aaa"), HostKeyVerdict::Unknown);

        let trusted = record("SHA256:aaa");
        assert_eq!(
            evaluate(Some(&trusted), "SHA256:aaa"),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            evaluate(Some(&trusted), "SHA256:bbb"),
            HostKeyVerdict::Mismatch {
                trusted: "SHA256:aaa".to_string(),
                presented: "SHA256:bbb".to_string(),
            }
        );
    }

    #[test]
    fn missing_record_is_unknown_then_trusted() {
        let scratch = Scratch::new("trust");
        let store = scratch.store();
        assert!(store.get("p1").expect("get").is_none());

        store
            .record("p1", "ssh-ed25519", "10.0.0.12", 22, "SHA256:aaa")
            .expect("record");
        let stored = store.get("p1").expect("get").expect("record");
        assert_eq!(stored.fingerprint, "SHA256:aaa");
        assert_eq!(stored.algorithm, "ssh-ed25519");
        assert_eq!(stored.port, 22);
        assert_eq!(
            evaluate(Some(&stored), "SHA256:aaa"),
            HostKeyVerdict::Trusted
        );
    }

    #[test]
    fn keep_trusted_host_keys_json_in_one_file() {
        // The store must not leave a `.tmp` behind after a write.
        let scratch = Scratch::new("tmp");
        let store = scratch.store();
        store
            .record("p1", "ssh-ed25519", "host", 22, "SHA256:aaa")
            .expect("record");
        assert!(scratch.0.join(KNOWN_HOSTS_FILE).exists());
        assert!(!scratch.0.join("known_hosts.json.tmp").exists());
    }

    #[test]
    fn forget_returns_to_unknown() {
        let scratch = Scratch::new("forget");
        let store = scratch.store();
        store
            .record("p1", "ssh-ed25519", "host", 22, "SHA256:aaa")
            .expect("record");
        store.forget("p1").expect("forget");
        assert_eq!(
            evaluate(store.get("p1").expect("get").as_ref(), "SHA256:aaa"),
            HostKeyVerdict::Unknown
        );
    }

    #[test]
    fn trust_pending_writes_the_presented_key() {
        let scratch = Scratch::new("pending");
        let store = scratch.store();
        let profile = format!("pending-{}", uuid::Uuid::new_v4());

        remember_pending(&profile, "SHA256:ccc", "ssh-rsa", "example.com", 2222);
        store
            .trust_pending(&profile, "SHA256:ccc")
            .expect("trust pending");

        let stored = store.get(&profile).expect("get").expect("record");
        assert_eq!(stored.fingerprint, "SHA256:ccc");
        assert_eq!(stored.algorithm, "ssh-rsa");
        assert_eq!(stored.host, "example.com");
        assert_eq!(stored.port, 2222);

        // The pending slot is consumed.
        assert!(store.trust_pending(&profile, "SHA256:ccc").is_err());
    }

    #[test]
    fn trust_pending_rejects_a_different_fingerprint() {
        let scratch = Scratch::new("pending-mismatch");
        let store = scratch.store();
        let profile = format!("pending-{}", uuid::Uuid::new_v4());

        remember_pending(&profile, "SHA256:ccc", "ssh-ed25519", "host", 22);
        assert!(store.trust_pending(&profile, "SHA256:ddd").is_err());
        assert!(store.get(&profile).expect("get").is_none());
    }

    #[test]
    fn trust_pending_cannot_overwrite_a_trusted_key() {
        let scratch = Scratch::new("pending-existing");
        let store = scratch.store();
        let profile = format!("pending-{}", uuid::Uuid::new_v4());

        store
            .record(&profile, "ssh-ed25519", "host", 22, "SHA256:aaa")
            .expect("record");
        remember_pending(&profile, "SHA256:bbb", "ssh-ed25519", "host", 22);
        let error = store.trust_pending(&profile, "SHA256:bbb").expect_err("mismatch");
        assert_eq!(crate::error::ServerErrorCode::HostKeyMismatch, error.code);
        assert_eq!(
            store.get(&profile).expect("get").expect("record").fingerprint,
            "SHA256:aaa"
        );
    }
}
