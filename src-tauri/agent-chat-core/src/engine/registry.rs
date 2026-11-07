//! Run and session registry.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! One child process is keyed twice: by its run id and by its native session
//! id once known. Both keys hold clones of the same [`ChildEntry`], so either
//! route can interrupt it. The map lock is only held for lookups and inserts;
//! killing, stdin writes and spawns always happen with the lock released.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as TokioMutex;

use crate::engine::resolve;
use crate::error::AgentChatError;

/// One live child shared by every registry key of a run.
#[derive(Clone)]
pub struct ChildEntry {
    /// `None` for runs driven by their own transport: only `killed` is routed.
    pub child: Option<Arc<TokioMutex<Child>>>,
    pub pid: u32,
    /// The run id this entry started under, even after a session alias exists.
    pub run_id: String,
    /// Set by `kill`: a user-initiated stop is not an error.
    pub killed: Arc<AtomicBool>,
    /// Interactive stdin kept open past the payload; answers ride this pipe.
    pub stdin: Option<Arc<TokioMutex<Option<ChildStdin>>>>,
    /// Pending question requests (request id -> full tool input).
    pub questions: Arc<Mutex<HashMap<String, Value>>>,
}

#[derive(Default)]
pub struct ProcessRegistry {
    entries: Mutex<HashMap<String, ChildEntry>>,
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Clone the entry registered under a run id or a session id.
    pub fn get(&self, key: &str) -> Option<ChildEntry> {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(key).cloned())
    }

    /// Register an entry under `key`, replacing any stale alias.
    pub fn insert(&self, key: String, entry: ChildEntry) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key, entry);
        }
    }

    /// Drop the entry for `key` together with every alias of the same run.
    pub fn remove(&self, key: &str) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        match entries.get(key).map(|entry| entry.run_id.clone()) {
            Some(run_id) => entries.retain(|_, entry| entry.run_id != run_id),
            None => {
                entries.remove(key);
            }
        }
    }

    /// The subset of `run_ids` still mid-turn. Matched on the entry's run id,
    /// not the map key, so a session alias never hides a live run.
    pub fn live_run_ids(&self, run_ids: &[String]) -> Vec<String> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };
        let live: std::collections::HashSet<&str> = entries
            .values()
            .map(|entry| entry.run_id.as_str())
            .collect();
        run_ids
            .iter()
            .filter(|run_id| live.contains(run_id.as_str()))
            .cloned()
            .collect()
    }

    /// Kill one run's process tree. Returns false when no entry matched.
    ///
    /// The killed flag is raised under the map lock; the process tree is
    /// signalled after the lock is released, because `taskkill` blocks.
    pub fn kill(&self, key: &str) -> bool {
        let targets: Vec<ChildEntry> = match self.entries.lock() {
            Ok(entries) => {
                let run_id = entries
                    .get(key)
                    .map(|entry| entry.run_id.clone())
                    .unwrap_or_else(|| key.to_string());
                let mut seen = std::collections::HashSet::new();
                entries
                    .values()
                    .filter(|entry| entry.run_id == run_id)
                    .filter(|entry| seen.insert(entry.pid))
                    .cloned()
                    .collect()
            }
            Err(_) => Vec::new(),
        };
        if targets.is_empty() {
            return false;
        }
        for entry in &targets {
            entry.killed.store(true, Ordering::SeqCst);
        }
        for entry in &targets {
            kill_entry(entry);
        }
        true
    }

    /// Kill every live run and clear the registry. Called on app exit.
    pub fn shutdown(&self) {
        let targets: Vec<ChildEntry> = match self.entries.lock() {
            Ok(mut entries) => {
                let mut seen = std::collections::HashSet::new();
                entries
                    .drain()
                    .map(|(_, entry)| entry)
                    .filter(|entry| seen.insert(entry.pid))
                    .collect()
            }
            Err(poisoned) => {
                let mut entries = poisoned.into_inner();
                let mut seen = std::collections::HashSet::new();
                entries
                    .drain()
                    .map(|(_, entry)| entry)
                    .filter(|entry| seen.insert(entry.pid))
                    .collect()
            }
        };
        for entry in &targets {
            entry.killed.store(true, Ordering::SeqCst);
        }
        for entry in &targets {
            kill_entry(entry);
        }
    }

    /// Write one NDJSON line to a live run's interactive stdin.
    pub async fn write_line(&self, key: &str, line: String) -> Result<(), AgentChatError> {
        let stdin = self
            .get(key)
            .and_then(|entry| entry.stdin)
            .ok_or_else(|| AgentChatError::not_running(key))?;
        let mut guard = stdin.lock().await;
        let handle = guard.as_mut().ok_or_else(|| {
            AgentChatError::internal("The run's standard input is already closed.")
        })?;
        handle
            .write_all(line.as_bytes())
            .await
            .map_err(|error| {
                AgentChatError::internal(format!(
                    "Writing to the run's standard input failed: {error}"
                ))
            })?;
        handle.write_all(b"\n").await.map_err(|error| {
            AgentChatError::internal(format!(
                "Writing to the run's standard input failed: {error}"
            ))
        })
    }

    /// Close a run's interactive stdin so the CLI exits after the turn.
    pub fn close_stdin(&self, key: &str) {
        let Some(stdin) = self.get(key).and_then(|entry| entry.stdin) else {
            return;
        };
        if let Ok(mut guard) = stdin.try_lock() {
            *guard = None;
            return;
        }
        tauri::async_runtime::spawn(async move {
            *stdin.lock().await = None;
        });
    }
}

/// Signal one entry's process tree, then the child handle itself.
fn kill_entry(entry: &ChildEntry) {
    let Some(child) = &entry.child else {
        return;
    };
    if let Ok(mut guard) = child.try_lock() {
        if matches!(guard.try_wait(), Ok(Some(_))) {
            return;
        }
        resolve::kill_process_tree(entry.pid);
        let _ = guard.start_kill();
    } else {
        // The reader holds the lock while reaping; the tree kill still lands.
        resolve::kill_process_tree(entry.pid);
    }
}

/// A run id from the caller, or a fresh uuid.
pub fn run_id_from_input(input: Option<String>) -> String {
    match input {
        Some(id) if !id.trim().is_empty() => id,
        _ => uuid::Uuid::new_v4().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(run_id: &str, pid: u32) -> ChildEntry {
        ChildEntry {
            child: None,
            pid,
            run_id: run_id.to_string(),
            killed: Arc::new(AtomicBool::new(false)),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[test]
    fn a_run_is_reachable_by_run_id_and_session_id() {
        let registry = ProcessRegistry::new();
        registry.insert("run-1".to_string(), entry("run-1", 0));
        let alias = registry.get("run-1").expect("run entry");
        registry.insert("session-1".to_string(), alias);

        assert!(registry.get("session-1").is_some());
        assert_eq!(
            registry.live_run_ids(&["run-1".to_string(), "run-2".to_string()]),
            vec!["run-1".to_string()]
        );

        registry.remove("session-1");
        assert!(registry.get("run-1").is_none());
        assert!(registry.get("session-1").is_none());
    }

    #[test]
    fn kill_raises_the_flag_for_every_alias_once() {
        let registry = ProcessRegistry::new();
        registry.insert("run-1".to_string(), entry("run-1", 0));
        let alias = registry.get("run-1").expect("run entry");
        registry.insert("session-1".to_string(), alias);

        let killed = registry.get("run-1").expect("run entry").killed;
        assert!(registry.kill("session-1"));
        assert!(killed.load(Ordering::SeqCst));
        assert!(!registry.kill("unknown"));
    }

    #[test]
    fn shutdown_drops_every_key() {
        let registry = ProcessRegistry::new();
        registry.insert("run-1".to_string(), entry("run-1", 0));
        registry.insert("session-1".to_string(), entry("run-1", 0));
        registry.shutdown();
        assert!(registry.get("run-1").is_none());
        assert!(registry.live_run_ids(&["run-1".to_string()]).is_empty());
    }
}
