use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One engine as the picker renders it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineInfo {
    /// "claude" | "codex" | "qoder"
    pub id: String,
    /// "Claude Code" | "Codex" | "Qoder"
    pub label: String,
    pub available: bool,
    pub bin: Option<String>,
    /// Static candidates reported by the engine; empty means "free input only".
    pub models: Vec<String>,
    pub supports_effort: bool,
    /// auto | manual | plan | bypass
    pub permissions: Vec<String>,
    /// "child" | "own"
    pub transport: String,
}

/// One `agent_send` call.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendInput {
    pub engine: String,
    pub workspace_path: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission: Option<String>,
    /// Claude only: directories granted through the permission card.
    pub additional_dirs: Option<Vec<String>>,
    /// Frontend-generated run id; the backend generates one when absent.
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendResult {
    pub run_id: String,
    pub session_id: Option<String>,
}

/// One normalized event. `agent:event` carries an array of these.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunEvent {
    pub run_id: String,
    pub session_id: Option<String>,
    pub engine: String,
    pub seq: u64,
    pub kind: String,
    pub data: serde_json::Value,
    /// Unix milliseconds at emit time.
    pub ts: i64,
}

/// One native session row in the sidebar.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionMeta {
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    pub file_path: String,
    pub file_size: i64,
    pub file_mtime_ms: i64,
    pub title: String,
    pub preview: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: i64,
}

/// One transcript row read from a native session file.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub seq: i64,
    /// user | assistant | thinking | tool
    pub role: String,
    pub text: String,
    pub ts: Option<String>,
    pub path: Option<String>,
    pub args: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub tool_call_id: Option<String>,
    pub model: Option<String>,
    pub usage: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionPage {
    pub messages: Vec<AgentMessage>,
    pub next_before: Option<i64>,
}

/// `ui.json`: open tabs, the active tab and per-engine preferences.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentUiState {
    pub version: u32,
    pub open_tabs: Vec<AgentTab>,
    pub active_tab_id: Option<String>,
    pub last_engine: String,
    pub engines: BTreeMap<String, AgentEnginePrefs>,
    pub grants: BTreeMap<String, Vec<String>>,
    pub recent_workspaces: Vec<String>,
}

impl Default for AgentUiState {
    fn default() -> Self {
        let mut engines = BTreeMap::new();
        engines.insert(
            "claude".to_string(),
            AgentEnginePrefs::with_permission("manual"),
        );
        engines.insert(
            "codex".to_string(),
            AgentEnginePrefs::with_permission("auto"),
        );
        engines.insert(
            "qoder".to_string(),
            AgentEnginePrefs::with_permission("bypass"),
        );
        Self {
            version: 1,
            open_tabs: Vec::new(),
            active_tab_id: None,
            last_engine: "claude".to_string(),
            engines,
            grants: BTreeMap::new(),
            recent_workspaces: Vec::new(),
        }
    }
}

impl AgentUiState {
    /// Clamp the persisted collections to the limits documented in §5.1.
    pub fn sanitize(&mut self) {
        if self.version == 0 {
            self.version = 1;
        }
        if self.open_tabs.len() > 20 {
            self.open_tabs.truncate(20);
        }
        if let Some(active) = &self.active_tab_id {
            if !self.open_tabs.iter().any(|tab| &tab.tab_id == active) {
                self.active_tab_id = self.open_tabs.first().map(|tab| tab.tab_id.clone());
            }
        }
        let mut seen = std::collections::HashSet::new();
        self.recent_workspaces
            .retain(|path| !path.is_empty() && seen.insert(path.clone()));
        if self.recent_workspaces.len() > 10 {
            self.recent_workspaces.truncate(10);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTab {
    pub tab_id: String,
    pub engine: String,
    pub session_id: Option<String>,
    pub workspace_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEnginePrefs {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission: Option<String>,
}

impl Default for AgentEnginePrefs {
    fn default() -> Self {
        Self {
            model: Some(String::new()),
            effort: Some(String::new()),
            permission: None,
        }
    }
}

impl AgentEnginePrefs {
    pub fn with_permission(permission: &str) -> Self {
        Self {
            model: Some(String::new()),
            effort: Some(String::new()),
            permission: Some(permission.to_string()),
        }
    }
}
