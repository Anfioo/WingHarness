//! Saved passwords.
//!
//! The reference project kept these in the OS keychain through `ide-ssh`. This
//! port has no keychain counterpart, so they live in one plain JSON file under
//! the data directory. That is a deliberate trade-off: the file is readable by
//! anything running as the user, so the UI says so next to the "Save password"
//! checkbox. Passwords are still never logged and never part of an error string.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::error::{DbError, DbResult};

/// Passwords keyed by data source id.
///
/// The file is read on every call rather than cached: it is tiny, and two
/// stores over the same file must never disagree about a password.
pub struct SecretStore {
    path: PathBuf,
}

/// Serialises read-modify-write across every store sharing the file.
static LOCK: Mutex<()> = Mutex::new(());

impl SecretStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The saved password of the data source `id`.
    pub fn get(&self, id: &str) -> DbResult<Option<String>> {
        let _guard = lock();
        Ok(read(&self.path)?.get(id).cloned())
    }

    /// Saves the password of the data source `id`, replacing the previous one.
    pub fn set(&self, id: &str, password: &str) -> DbResult<()> {
        let _guard = lock();
        let mut values = read(&self.path)?;
        if values.get(id).is_some_and(|saved| saved == password) {
            return Ok(());
        }
        values.insert(id.to_owned(), password.to_owned());
        self.store(&values)
    }

    /// Forgets the password of the data source `id`.
    pub fn remove(&self, id: &str) -> DbResult<()> {
        let _guard = lock();
        let mut values = read(&self.path)?;
        if values.remove(id).is_some() {
            self.store(&values)?;
        }
        Ok(())
    }

    fn store(&self, values: &HashMap<String, String>) -> DbResult<()> {
        let mut object = Map::new();
        for (id, password) in values {
            object.insert(id.clone(), Value::String(password.clone()));
        }
        write(&self.path, &Value::Object(object))
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read(path: &Path) -> DbResult<HashMap<String, String>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.into()),
    };
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| DbError::invalid(format!("{}: {error}", path.display())))?;
    let Value::Object(object) = value else {
        return Err(DbError::invalid(format!("{}: expected an object", path.display())));
    };
    Ok(object
        .into_iter()
        .filter_map(|(id, value)| match value {
            Value::String(password) => Some((id, password)),
            _ => None,
        })
        .collect())
}

fn write(path: &Path, value: &Value) -> DbResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| DbError::internal(error.to_string()))?;
    // Write next to the target and rename, so a crash cannot leave half a file.
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text)?;
    restrict(&temporary)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Owner-only permissions where the platform has them.
#[cfg(unix)]
fn restrict(path: &Path) -> DbResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> DbResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_reads_and_forgets_passwords() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secrets.json");
        let store = SecretStore::new(path.clone());
        assert_eq!(store.get("a").unwrap(), None);
        store.set("a", "one").unwrap();
        store.set("b", "two").unwrap();
        assert_eq!(store.get("a").unwrap().as_deref(), Some("one"));
        // A fresh store sees what the previous one wrote.
        let reopened = SecretStore::new(path.clone());
        assert_eq!(reopened.get("b").unwrap().as_deref(), Some("two"));
        reopened.remove("a").unwrap();
        assert_eq!(reopened.get("a").unwrap(), None);
        assert_eq!(store.get("a").unwrap(), None, "the removed password must not come back");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1, "no temporary file is left behind");
    }

    #[test]
    fn ignores_a_missing_or_empty_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secrets.json");
        assert_eq!(SecretStore::new(path.clone()).get("a").unwrap(), None);
        std::fs::write(&path, "  \n").unwrap();
        assert_eq!(SecretStore::new(path.clone()).get("a").unwrap(), None);
        std::fs::write(&path, "[]").unwrap();
        assert!(SecretStore::new(path).get("a").is_err());
    }

    #[test]
    fn keeps_only_string_values() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("secrets.json");
        std::fs::write(&path, r#"{"a":"x","b":1}"#).unwrap();
        let store = SecretStore::new(path);
        assert_eq!(store.get("a").unwrap().as_deref(), Some("x"));
        assert_eq!(store.get("b").unwrap(), None);
    }
}
