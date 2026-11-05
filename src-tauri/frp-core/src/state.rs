use std::sync::{Arc, Mutex};

use crate::models::Workspace;
use crate::process::ProcessRegistry;

/// State registered by the root crate and injected into every command.
pub struct FrpState {
    /// Used to emit `frp:*` events to the main window.
    pub app: tauri::AppHandle,
    /// In-memory workspace cache. The store lane fills it on the first load and
    /// every write; the lock is only held long enough to clone, never across
    /// `frpc verify`, a spawn or an emit.
    pub workspace: Mutex<Option<Workspace>>,
    /// Child processes and their log buffers. The registry has its own locks and
    /// never touches the workspace.
    pub process: Arc<ProcessRegistry>,
}

impl FrpState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let process = Arc::new(ProcessRegistry::new(app.clone()));
        Self {
            app,
            workspace: Mutex::new(None),
            process,
        }
    }

    /// The cached workspace, or `None` before the first load.
    pub fn cached_workspace(&self) -> Option<Workspace> {
        self.workspace.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn cache_workspace(&self, workspace: Workspace) {
        if let Ok(mut guard) = self.workspace.lock() {
            *guard = Some(workspace);
        }
    }

    /// Stop every `frpc` child process this session started. Idempotent; the
    /// root crate calls this on `RunEvent::Exit`.
    pub fn shutdown(&self) {
        self.process.shutdown();
    }
}
