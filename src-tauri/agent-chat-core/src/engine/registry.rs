//! Run and session registry.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 keeps the bookkeeping only; B1 adds the child handles, `write_line`
//! and the question map. The lock is never held across I/O.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Debug, Default)]
pub struct RunEntry {
    pub run_id: String,
    pub engine: String,
    pub session_id: Option<String>,
}

#[derive(Default)]
pub struct ProcessRegistry {
    runs: Mutex<HashMap<String, RunEntry>>,
    /// Session id -> run id, so a resumed session can be found without
    /// scanning every entry.
    sessions: Mutex<HashMap<String, String>>,
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, entry: RunEntry) {
        if let Some(session_id) = &entry.session_id {
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.insert(session_id.clone(), entry.run_id.clone());
            }
        }
        if let Ok(mut runs) = self.runs.lock() {
            runs.insert(entry.run_id.clone(), entry);
        }
    }

    pub fn remove(&self, run_id: &str) -> Option<RunEntry> {
        let entry = self.runs.lock().ok()?.remove(run_id)?;
        if let (Some(session_id), Ok(mut sessions)) = (&entry.session_id, self.sessions.lock()) {
            sessions.remove(session_id);
        }
        Some(entry)
    }

    pub fn is_live(&self, run_id: &str) -> bool {
        self.runs
            .lock()
            .map(|runs| runs.contains_key(run_id))
            .unwrap_or(false)
    }

    pub fn run_for_session(&self, session_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .ok()?
            .get(session_id)
            .cloned()
    }

    pub fn live_run_ids(&self, run_ids: &[String]) -> Vec<String> {
        let Ok(runs) = self.runs.lock() else {
            return Vec::new();
        };
        run_ids
            .iter()
            .filter(|run_id| runs.contains_key(*run_id))
            .cloned()
            .collect()
    }

    /// A0 registers no child process, so this only drops the entry. B1 adds
    /// the process tree kill behind the same signature.
    pub fn kill(&self, run_id: &str) -> bool {
        self.remove(run_id).is_some()
    }

    /// Drops every entry. The root crate calls this on `RunEvent::Exit`.
    pub fn shutdown(&self) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.clear();
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }
}

pub fn run_id_from_input(input: Option<String>) -> String {
    match input {
        Some(id) if !id.trim().is_empty() => id,
        _ => uuid::Uuid::new_v4().to_string(),
    }
}
