//! Query history (IDEA's Browse Query History): the statements each data
//! source ran, newest first.
//!
//! Ported from `ide_db::history` of the reference project (Apache-2.0). Unlike
//! the original, entries are keyed by data source id alone rather than by
//! project and data source: ids are unique across the app, and a global data
//! source is the same server whichever project is open, so its history is too.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{DbError, DbResult};

/// Statements kept per data source.
pub const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub text: String,
    /// Milliseconds since the Unix epoch.
    pub time: f64,
}

/// Data source id → entries, newest first.
type Contents = BTreeMap<String, Vec<HistoryEntry>>;

/// Serialises read-modify-write across every store sharing the file.
static LOCK: Mutex<()> = Mutex::new(());

pub struct HistoryStore {
    path: PathBuf,
}

impl HistoryStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self, source: &str) -> Vec<HistoryEntry> {
        let _guard = lock();
        self.read().remove(source).unwrap_or_default()
    }

    /// Records `text`; running a statement again moves it to the top.
    pub fn add(&self, source: &str, text: &str, time: f64) -> DbResult<()> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let _guard = lock();
        let mut all = self.read();
        let entries = all.entry(source.to_owned()).or_default();
        entries.retain(|entry| entry.text != text);
        entries.insert(0, HistoryEntry { text: text.to_owned(), time });
        entries.truncate(MAX_ENTRIES);
        self.write(&all)
    }

    /// Removes the entries with these texts (all of them for `None`).
    pub fn remove(&self, source: &str, texts: Option<&[String]>) -> DbResult<()> {
        let _guard = lock();
        let mut all = self.read();
        match texts {
            None => {
                all.remove(source);
            }
            Some(texts) => {
                if let Some(entries) = all.get_mut(source) {
                    entries.retain(|entry| !texts.contains(&entry.text));
                }
            }
        }
        self.write(&all)
    }

    /// A file that cannot be read is treated as empty: history is a convenience,
    /// never the reason a query fails to run.
    fn read(&self) -> Contents {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                log::warn!("query history: {}: {error}", self.path.display());
                Contents::new()
            }),
            Err(_) => Contents::new(),
        }
    }

    fn write(&self, all: &Contents) -> DbResult<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let temporary = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(all).map_err(|error| DbError::internal(error.to_string()))?;
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(entries: Vec<HistoryEntry>) -> Vec<String> {
        entries.into_iter().map(|entry| entry.text).collect()
    }

    #[test]
    fn keeps_newest_first_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(dir.path().join("history.json"));
        store.add("s1", "select 1", 1.0).unwrap();
        store.add("s1", " select 2 ", 2.0).unwrap();
        store.add("s1", "select 1", 3.0).unwrap();
        store.add("s1", "  ", 4.0).unwrap();
        store.add("s2", "select 3", 5.0).unwrap();
        assert_eq!(texts(store.list("s1")), ["select 1", "select 2"]);
        assert_eq!(texts(store.list("s2")), ["select 3"]);
        store.remove("s1", Some(&["select 2".to_owned()])).unwrap();
        assert_eq!(texts(store.list("s1")), ["select 1"]);
        store.remove("s1", None).unwrap();
        assert!(store.list("s1").is_empty());
        assert_eq!(texts(store.list("s2")), ["select 3"]);
    }

    #[test]
    fn caps_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::new(dir.path().join("history.json"));
        for i in 0..MAX_ENTRIES + 5 {
            store.add("s", &format!("select {i}"), i as f64).unwrap();
        }
        let list = store.list("s");
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0].text, format!("select {}", MAX_ENTRIES + 4));
    }

    #[test]
    fn a_damaged_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        std::fs::write(&path, "not json").unwrap();
        let store = HistoryStore::new(path.clone());
        assert!(store.list("s").is_empty());
        store.add("s", "select 1", 1.0).unwrap();
        assert_eq!(texts(store.list("s")), ["select 1"]);
    }
}
