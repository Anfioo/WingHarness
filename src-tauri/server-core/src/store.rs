//! Persistence for server profiles and preferences (`servers.json`).
//!
//! Every write goes through `servers.json.tmp` plus a rename, so a crash can
//! never leave a half-written profile list behind. A file that cannot be
//! parsed is moved aside as `servers.json.bak-<unix timestamp>` and the caller
//! gets the defaults, so the feature starts clean instead of writing over
//! whatever the user had.
//!
//! Credentials are stored in this file as plain text, by explicit user request.
//! `version` records whether the one-shot keychain migration has run: a file
//! read as version 1 still has to pull its secrets out of the OS keychain.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex; // std Mutex: every operation here is synchronous file IO.

use serde::{Deserialize, Serialize};

use crate::error::{ServerError, ServerResult};
use crate::models::{SecretKind, ServerPrefs, ServerProfile, ServerProfileInput, ServerProfilesView};
use crate::paths;

const VERSION: u32 = 2;
const SERVERS_FILE: &str = "servers.json";
/// Terminal type used when a profile does not name one.
pub(crate) const DEFAULT_TERMINAL_TYPE: &str = "xterm-256color";
/// Accent colour used when a profile does not name one.
pub(crate) const DEFAULT_COLOR: &str = "#4f8cff";
const DEFAULT_PORT: u16 = 22;
const MAX_CONCURRENT_TRANSFERS: u32 = 10;
/// Largest legacy key file the v1 -> v2 migration will inline.
const LEGACY_KEY_MAX_BYTES: u64 = 1024 * 1024;

/// Serialises the read-modify-write cycle of every JSON file in the data
/// directory, so two commands cannot lose each other's write.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Seconds since the Unix epoch; every timestamp in this feature uses it.
pub(crate) fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// The on-disk shape of `servers.json` (§5.1 of the plan).
///
/// Parsed tolerantly: a profile row that no longer matches the schema is
/// dropped with a warning instead of taking the whole file down.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServersFile {
    version: u32,
    #[serde(default)]
    profiles: Vec<ServerProfile>,
    #[serde(default)]
    prefs: ServerPrefs,
}

impl Default for ServersFile {
    fn default() -> Self {
        Self {
            version: VERSION,
            profiles: Vec::new(),
            prefs: ServerPrefs::default(),
        }
    }
}

/// One profile store rooted at the server data directory.
///
/// The root is a field (not a global) so the unit tests can point it at a
/// scratch directory; production code always goes through `Store::open`.
#[derive(Debug)]
pub(crate) struct Store {
    root: PathBuf,
}

impl Store {
    /// The store of the running app.
    pub(crate) fn open() -> ServerResult<Self> {
        Ok(Self {
            root: paths::dir()?.clone(),
        })
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self) -> PathBuf {
        self.root.join(SERVERS_FILE)
    }

    fn temp_path(&self) -> PathBuf {
        self.root.join(format!("{SERVERS_FILE}.tmp"))
    }

    /// Profiles and preferences in one read, for `server_profiles_list`.
    pub(crate) fn snapshot(&self) -> ServerResult<ServerProfilesView> {
        let file = self.read();
        Ok(ServerProfilesView {
            profiles: file.profiles,
            prefs: file.prefs,
        })
    }

    pub(crate) fn profiles(&self) -> ServerResult<Vec<ServerProfile>> {
        Ok(self.read().profiles)
    }

    pub(crate) fn profile(&self, id: &str) -> ServerResult<Option<ServerProfile>> {
        Ok(self.read().profiles.into_iter().find(|p| p.id == id))
    }

    pub(crate) fn create(&self, input: &ServerProfileInput) -> ServerResult<ServerProfile> {
        self.mutate(|file| {
            let now = unix_now();
            let profile = normalize_profile(ServerProfile {
                id: uuid::Uuid::new_v4().to_string(),
                name: input.name.clone(),
                host: input.host.clone(),
                port: input.port,
                username: input.username.clone(),
                auth_kind: input.auth_kind,
                private_key: input.private_key.clone(),
                password: input.password.clone(),
                passphrase: input.passphrase.clone(),
                terminal_type: input.terminal_type.clone().unwrap_or_default(),
                note: input.note.clone().unwrap_or_default(),
                color: input.color.clone().unwrap_or_default(),
                created_at: now,
                updated_at: now,
                last_connected_at: None,
            });
            file.profiles.push(profile.clone());
            Ok(profile)
        })
    }

    pub(crate) fn update(&self, id: &str, input: &ServerProfileInput) -> ServerResult<ServerProfile> {
        self.mutate(|file| {
            let index = file
                .profiles
                .iter()
                .position(|profile| profile.id == id)
                .ok_or_else(|| ServerError::not_found(id))?;
            let existing = file.profiles[index].clone();
            let profile = normalize_profile(ServerProfile {
                id: existing.id,
                name: input.name.clone(),
                host: input.host.clone(),
                port: input.port,
                username: input.username.clone(),
                auth_kind: input.auth_kind,
                private_key: input.private_key.clone(),
                password: input.password.clone(),
                passphrase: input.passphrase.clone(),
                terminal_type: input.terminal_type.clone().unwrap_or_default(),
                note: input.note.clone().unwrap_or_default(),
                color: input.color.clone().unwrap_or_default(),
                created_at: existing.created_at,
                updated_at: unix_now(),
                last_connected_at: existing.last_connected_at,
            });
            file.profiles[index] = profile.clone();
            Ok(profile)
        })
    }

    /// Remove one profile; `Ok(false)` means it was already gone.
    pub(crate) fn delete(&self, id: &str) -> ServerResult<bool> {
        self.mutate(|file| {
            let before = file.profiles.len();
            file.profiles.retain(|profile| profile.id != id);
            Ok(file.profiles.len() != before)
        })
    }

    /// Reorder the list to match `ids`. Unknown ids are ignored and profiles
    /// missing from `ids` keep their previous order at the end.
    pub(crate) fn reorder(&self, ids: &[String]) -> ServerResult<()> {
        self.mutate(|file| {
            let mut remaining: HashMap<String, ServerProfile> = std::mem::take(&mut file.profiles)
                .into_iter()
                .map(|profile| (profile.id.clone(), profile))
                .collect();
            let mut ordered = Vec::with_capacity(remaining.len());
            for id in ids {
                if let Some(profile) = remaining.remove(id) {
                    ordered.push(profile);
                }
            }
            let mut rest: Vec<ServerProfile> = remaining.into_values().collect();
            rest.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
            ordered.extend(rest);
            file.profiles = ordered;
            Ok(())
        })
    }

    /// Remember when a profile was last connected to.
    pub(crate) fn touch_connected(&self, id: &str, at: i64) -> ServerResult<()> {
        self.mutate(|file| {
            if let Some(profile) = file.profiles.iter_mut().find(|profile| profile.id == id) {
                profile.last_connected_at = Some(at);
                profile.updated_at = at;
            }
            Ok(())
        })
    }

    /// Whether `servers.json` predates the plaintext-credential format, so the
    /// one-shot keychain migration still has to run.
    pub(crate) fn needs_secret_migration(&self) -> bool {
        self.read().version < VERSION
    }

    /// Write one credential into the profile's plaintext field. An empty value
    /// clears the field instead of storing a blank credential.
    pub(crate) fn set_secret(&self, id: &str, kind: SecretKind, value: &str) -> ServerResult<()> {
        self.mutate(|file| {
            let profile = file
                .profiles
                .iter_mut()
                .find(|profile| profile.id == id)
                .ok_or_else(|| ServerError::not_found(id))?;
            let value = non_empty(Some(value.to_string()));
            match kind {
                SecretKind::Password => profile.password = value,
                SecretKind::Passphrase => profile.passphrase = value,
            }
            profile.updated_at = unix_now();
            Ok(())
        })
    }

    pub(crate) fn clear_secret(&self, id: &str, kind: SecretKind) -> ServerResult<()> {
        self.mutate(|file| {
            let profile = file
                .profiles
                .iter_mut()
                .find(|profile| profile.id == id)
                .ok_or_else(|| ServerError::not_found(id))?;
            match kind {
                SecretKind::Password => profile.password = None,
                SecretKind::Passphrase => profile.passphrase = None,
            }
            Ok(())
        })
    }

    /// Record that the legacy keychain migration finished for every profile.
    pub(crate) fn mark_migrated(&self) -> ServerResult<()> {
        self.mutate(|file| {
            file.version = VERSION;
            Ok(())
        })
    }

    pub(crate) fn prefs(&self) -> ServerResult<ServerPrefs> {
        Ok(self.read().prefs)
    }

    /// Write preferences. `ServerPrefs` is the whitelist: nothing outside it
    /// can reach the file, and out-of-range values are clamped.
    pub(crate) fn set_prefs(&self, prefs: &ServerPrefs) -> ServerResult<ServerPrefs> {
        let prefs = sanitize_prefs(prefs.clone());
        self.mutate(|file| {
            file.prefs = prefs.clone();
            Ok(prefs.clone())
        })
    }

    fn mutate<T>(
        &self,
        apply: impl FnOnce(&mut ServersFile) -> ServerResult<T>,
    ) -> ServerResult<T> {
        let _guard = WRITE_LOCK
            .lock()
            .map_err(|_| ServerError::internal("The server store is unavailable."))?;
        let mut file = self.read();
        let value = apply(&mut file)?;
        self.write(&file)?;
        Ok(value)
    }

    /// Read the file, falling back to defaults when it is missing or broken.
    fn read(&self) -> ServersFile {
        let path = self.path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ServersFile::default()
            }
            Err(error) => {
                log::warn!(
                    "server_store_read_failed path={} error={error}",
                    path.display()
                );
                return ServersFile::default();
            }
        };

        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => {
                log::warn!(
                    "server_store_parse_failed path={} error={error}",
                    path.display()
                );
                backup(&path, SERVERS_FILE);
                return ServersFile::default();
            }
        };

        ServersFile::from_value(&value)
    }

    fn write(&self, file: &ServersFile) -> ServerResult<()> {
        let bytes = serde_json::to_vec_pretty(file).map_err(|error| {
            log::warn!("server_store_encode_failed error={error}");
            ServerError::internal("The server profiles could not be saved.")
        })?;

        if let Err(error) = std::fs::create_dir_all(&self.root) {
            log::warn!(
                "server_store_dir_create_failed path={} error={error}",
                self.root.display()
            );
            return Err(ServerError::internal(
                "The server data directory could not be created.",
            ));
        }

        let temp = self.temp_path();
        let written = (|| -> std::io::Result<()> {
            let mut handle = std::fs::File::create(&temp)?;
            handle.write_all(&bytes)?;
            handle.sync_all()
        })();
        if let Err(error) = written {
            log::warn!(
                "server_store_write_failed path={} error={error}",
                temp.display()
            );
            let _ = std::fs::remove_file(&temp);
            return Err(ServerError::internal(
                "The server profiles could not be saved.",
            ));
        }

        if let Err(error) = std::fs::rename(&temp, self.path()) {
            log::warn!("server_store_rename_failed error={error}");
            let _ = std::fs::remove_file(&temp);
            return Err(ServerError::internal(
                "The server profiles could not be saved.",
            ));
        }
        Ok(())
    }
}

impl ServersFile {
    fn from_value(value: &serde_json::Value) -> Self {
        let mut file = ServersFile::default();
        file.version = value
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1) as u32;

        if let Some(prefs) = value.get("prefs") {
            match serde_json::from_value::<ServerPrefs>(prefs.clone()) {
                Ok(prefs) => file.prefs = prefs,
                Err(error) => log::warn!("server_store_prefs_invalid error={error}"),
            }
        }

        if let Some(rows) = value.get("profiles").and_then(|rows| rows.as_array()) {
            for (index, row) in rows.iter().enumerate() {
                // v1 kept only the path of the key file; read its content now so
                // the next write drops the field.
                let legacy_key_path = row
                    .get("privateKeyPath")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|path| !path.is_empty());

                match serde_json::from_value::<ServerProfile>(row.clone()) {
                    Ok(mut profile) if !profile.id.trim().is_empty() => {
                        if profile.private_key.is_none() {
                            if let Some(path) = legacy_key_path {
                                profile.private_key = read_legacy_key(path);
                            }
                        }
                        file.profiles.push(normalize_profile(profile))
                    }
                    Ok(_) => log::warn!("server_store_profile_invalid index={index} reason=empty-id"),
                    Err(error) => {
                        log::warn!("server_store_profile_invalid index={index} error={error}")
                    }
                }
            }
        }

        file.prefs = sanitize_prefs(file.prefs);
        file
    }
}

/// Read a v1 private key path into the plaintext field. Any failure keeps the
/// profile and only leaves the key unset, so no row is lost to a moved file.
fn read_legacy_key(path: &str) -> Option<String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            log::warn!("server_store_legacy_key_stat_failed path={path} error={error}");
            return None;
        }
    };
    if !metadata.is_file() {
        log::warn!("server_store_legacy_key_not_a_file path={path}");
        return None;
    }
    if metadata.len() > LEGACY_KEY_MAX_BYTES {
        log::warn!(
            "server_store_legacy_key_too_large path={path} size={}",
            metadata.len()
        );
        return None;
    }
    match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) => {
            log::warn!("server_store_legacy_key_read_failed path={path} error={error}");
            None
        }
    }
}

fn normalize_profile(mut profile: ServerProfile) -> ServerProfile {
    profile.name = profile.name.trim().to_string();
    profile.host = profile.host.trim().to_string();
    profile.username = profile.username.trim().to_string();
    profile.note = profile.note.trim().to_string();
    profile.private_key = non_empty(profile.private_key);
    profile.password = non_empty(profile.password);
    profile.passphrase = non_empty(profile.passphrase);
    if profile.port == 0 {
        profile.port = DEFAULT_PORT;
    }
    if profile.terminal_type.trim().is_empty() {
        profile.terminal_type = DEFAULT_TERMINAL_TYPE.to_string();
    } else {
        profile.terminal_type = profile.terminal_type.trim().to_string();
    }
    if profile.color.trim().is_empty() {
        profile.color = DEFAULT_COLOR.to_string();
    } else {
        profile.color = profile.color.trim().to_string();
    }
    profile
}

fn sanitize_prefs(mut prefs: ServerPrefs) -> ServerPrefs {
    prefs.local_pane_path = trimmed(prefs.local_pane_path);
    prefs.max_concurrent_transfers = prefs
        .max_concurrent_transfers
        .clamp(1, MAX_CONCURRENT_TRANSFERS);
    prefs
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Only an empty string means "unset". Passwords and private keys may contain
/// leading/trailing whitespace and their trailing newlines are significant, so
/// credentials are never trimmed.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// Move a file that cannot be parsed out of the way, keeping the bytes for
/// support instead of deleting the user's data.
pub(crate) fn backup(path: &std::path::Path, file_name: &str) {
    let target = path.with_file_name(format!("{file_name}.bak-{}", unix_now()));
    if let Err(error) = std::fs::rename(path, &target) {
        log::warn!(
            "server_store_backup_failed from={} to={} error={error}",
            path.display(),
            target.display()
        );
    }
}

/// Write any serialisable value to `path` through `<path>.tmp` + rename.
///
/// Shared with `host_keys` so both files follow the same atomic-write rule.
pub(crate) fn write_json_atomic<T: Serialize>(path: &std::path::Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
        let mut handle = std::fs::File::create(&temp)?;
        handle.write_all(&bytes)?;
        handle.sync_all()
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error
    })
}

/// Take the process-wide store lock. `host_keys` shares it so a profile
/// delete and a connect cannot interleave their reads and writes.
pub(crate) fn lock_for_write() -> ServerResult<std::sync::MutexGuard<'static, ()>> {
    WRITE_LOCK
        .lock()
        .map_err(|_| ServerError::internal("The server store is unavailable."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AuthKind;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "server-core-store-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).expect("scratch directory");
            Self(root)
        }

        fn store(&self) -> Store {
            Store::at(self.0.clone())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn input(name: &str) -> ServerProfileInput {
        ServerProfileInput {
            name: name.to_string(),
            host: "10.0.0.12".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_kind: AuthKind::Password,
            private_key: None,
            password: None,
            passphrase: None,
            terminal_type: None,
            note: None,
            color: None,
        }
    }

    #[test]
    fn first_start_returns_defaults() {
        let scratch = Scratch::new("first-start");
        let store = scratch.store();
        let snapshot = store.snapshot().expect("snapshot");
        assert!(snapshot.profiles.is_empty());
        assert_eq!(snapshot.prefs.max_concurrent_transfers, 3);
        assert!(!snapshot.prefs.show_hidden_local);
        assert_eq!(snapshot.prefs.conflict_policy, crate::models::ConflictPolicy::Ask);
        assert_eq!(snapshot.prefs.local_pane_path, None);
    }

    #[test]
    fn create_update_delete_round_trip() {
        let scratch = Scratch::new("crud");
        let store = scratch.store();

        let mut create = input("Production");
        create.password = Some("  pass with spaces  ".to_string());
        create.passphrase = Some("key passphrase".to_string());
        create.private_key = Some(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
                .to_string(),
        );
        let created = store.create(&create).expect("create");
        assert_eq!(created.name, "Production");
        assert_eq!(created.terminal_type, DEFAULT_TERMINAL_TYPE);
        assert_eq!(created.color, DEFAULT_COLOR);
        assert_eq!(store.profiles().expect("list").len(), 1);

        let reloaded = store
            .profile(&created.id)
            .expect("read")
            .expect("profile present");
        assert_eq!(reloaded.password, create.password);
        assert_eq!(reloaded.passphrase, create.passphrase);
        assert_eq!(reloaded.private_key, create.private_key);

        let mut edited = input("Production Web");
        edited.port = 2222;
        let updated = store.update(&created.id, &edited).expect("update");
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "Production Web");
        assert_eq!(updated.port, 2222);
        assert_eq!(updated.created_at, created.created_at);

        assert!(store.delete(&created.id).expect("delete"));
        assert!(!store.delete(&created.id).expect("delete again"));
        assert!(store.profiles().expect("list").is_empty());
    }

    #[test]
    fn plaintext_secrets_round_trip() {
        let scratch = Scratch::new("secrets");
        let store = scratch.store();

        let mut create = input("Secrets");
        create.password = Some("pa ss".to_string());
        create.passphrase = Some("phrase value".to_string());
        create.private_key = Some(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"
                .to_string(),
        );
        let created = store.create(&create).expect("create");

        let text = std::fs::read_to_string(scratch.0.join(SERVERS_FILE)).expect("read");
        assert!(text.contains("pa ss"), "the password must be stored verbatim");
        assert!(text.contains("phrase value"));
        assert!(text.contains("BEGIN OPENSSH PRIVATE KEY"));

        let mut edit = input("Secrets");
        edit.password = Some(String::new());
        edit.passphrase = Some(String::new());
        edit.private_key = Some(String::new());
        let updated = store.update(&created.id, &edit).expect("update");
        assert_eq!(updated.password, None);
        assert_eq!(updated.passphrase, None);
        assert_eq!(updated.private_key, None);

        let text = std::fs::read_to_string(scratch.0.join(SERVERS_FILE)).expect("read");
        assert!(text.contains("\"password\": null"));
        assert!(text.contains("\"passphrase\": null"));
        assert!(text.contains("\"privateKey\": null"));
    }

    #[test]
    fn legacy_private_key_path_is_migrated() {
        let scratch = Scratch::new("legacy-key");
        let key_path = scratch.0.join("id_ed25519");
        let key_text = "-----BEGIN OPENSSH PRIVATE KEY-----\nlegacy\n-----END OPENSSH PRIVATE KEY-----\n";
        std::fs::write(&key_path, key_text).expect("write key");

        let json = serde_json::json!({
            "version": 1,
            "profiles": [{
                "id": "legacy", "name": "old", "host": "h", "port": 22, "username": "u",
                "authKind": "privateKey",
                "privateKeyPath": key_path.to_string_lossy(),
                "terminalType": "xterm-256color", "note": "", "color": "#fff",
                "createdAt": 1, "updatedAt": 1, "lastConnectedAt": null
            }]
        });
        std::fs::write(
            scratch.0.join(SERVERS_FILE),
            serde_json::to_vec(&json).expect("encode"),
        )
        .expect("write");

        let store = scratch.store();
        assert!(store.needs_secret_migration());
        let snapshot = store.snapshot().expect("snapshot");
        assert_eq!(snapshot.profiles.len(), 1);
        assert_eq!(snapshot.profiles[0].private_key.as_deref(), Some(key_text));

        store.set_prefs(&ServerPrefs::default()).expect("write");
        let text = std::fs::read_to_string(scratch.0.join(SERVERS_FILE)).expect("read");
        assert!(!text.contains("privateKeyPath"), "the legacy path must disappear");
        assert!(text.contains("legacy"));

        store.mark_migrated().expect("mark migrated");
        assert!(!store.needs_secret_migration());
    }

    #[test]
    fn reorder_follows_given_ids() {
        let scratch = Scratch::new("reorder");
        let store = scratch.store();
        let first = store.create(&input("one")).expect("create");
        let second = store.create(&input("two")).expect("create");
        let third = store.create(&input("three")).expect("create");

        store
            .reorder(&[third.id.clone(), first.id.clone(), second.id.clone()])
            .expect("reorder");
        let ids: Vec<String> = store
            .profiles()
            .expect("list")
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(
            ids,
            vec![third.id.clone(), first.id.clone(), second.id.clone()]
        );

        // Unknown ids are ignored, missing ones keep their order at the end.
        store.reorder(&["missing".to_string(), second.id.clone()]).expect("reorder partial");
        let ids: Vec<String> = store
            .profiles()
            .expect("list")
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(ids[0], second.id);
    }

    #[test]
    fn corrupted_file_is_backed_up_and_reset() {
        let scratch = Scratch::new("corrupt");
        std::fs::write(scratch.0.join(SERVERS_FILE), b"{ not json").expect("write");
        let store = scratch.store();

        assert!(store.profiles().expect("list").is_empty());
        let backups: Vec<_> = std::fs::read_dir(&scratch.0)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("servers.json.bak-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "the broken file must be preserved");
        assert!(!scratch.0.join(SERVERS_FILE).exists());
    }

    #[test]
    fn invalid_rows_are_skipped() {
        let scratch = Scratch::new("partial");
        let json = serde_json::json!({
            "version": 1,
            "profiles": [
                { "id": "keep", "name": "ok", "host": "h", "port": 22, "username": "u",
                  "authKind": "password", "privateKey": null, "password": null,
                  "passphrase": null,
                  "terminalType": "xterm-256color", "note": "", "color": "#fff",
                  "createdAt": 1, "updatedAt": 1, "lastConnectedAt": null },
                { "id": "broken" },
                "not an object"
            ],
            "prefs": { "localPanePath": null, "showHiddenLocal": true,
                       "showHiddenRemote": false, "conflictPolicy": "ask",
                       "maxConcurrentTransfers": 99 }
        });
        std::fs::write(
            scratch.0.join(SERVERS_FILE),
            serde_json::to_vec(&json).expect("encode"),
        )
        .expect("write");

        let snapshot = scratch.store().snapshot().expect("snapshot");
        assert_eq!(snapshot.profiles.len(), 1);
        assert_eq!(snapshot.profiles[0].id, "keep");
        assert!(snapshot.prefs.show_hidden_local);
        assert_eq!(snapshot.prefs.max_concurrent_transfers, MAX_CONCURRENT_TRANSFERS);
    }

    #[test]
    fn write_leaves_no_temp_file() {
        let scratch = Scratch::new("tmp");
        let store = scratch.store();
        store.create(&input("one")).expect("create");
        store.set_prefs(&ServerPrefs::default()).expect("prefs");

        assert!(scratch.0.join(SERVERS_FILE).exists());
        assert!(!scratch.0.join(format!("{SERVERS_FILE}.tmp")).exists());
        let leftovers: Vec<_> = std::fs::read_dir(&scratch.0)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn prefs_are_clamped_and_trimmed() {
        let scratch = Scratch::new("prefs");
        let store = scratch.store();
        let prefs = ServerPrefs {
            local_pane_path: Some("   ".to_string()),
            show_hidden_local: true,
            show_hidden_remote: false,
            conflict_policy: crate::models::ConflictPolicy::Overwrite,
            max_concurrent_transfers: 0,
        };
        let saved = store.set_prefs(&prefs).expect("set prefs");
        assert_eq!(saved.local_pane_path, None);
        assert_eq!(saved.max_concurrent_transfers, 1);

        let loaded = store.prefs().expect("get prefs");
        assert_eq!(loaded.conflict_policy, crate::models::ConflictPolicy::Overwrite);
        assert!(loaded.show_hidden_local);
    }
}
