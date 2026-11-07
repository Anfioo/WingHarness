use std::fs;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AgentChatError, AgentChatResult};
use crate::models::AgentUiState;
use crate::paths;

/// Reads `ui.json`, falling back to defaults for a missing or unreadable file.
///
/// A corrupt file is copied aside as `ui.json.bak-<unix seconds>` before the
/// defaults are returned, so the user's tabs are not silently lost.
pub fn load() -> AgentChatResult<AgentUiState> {
    let path = paths::ui_path()?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentUiState::default());
        }
        Err(error) => {
            return Err(AgentChatError::internal(format!(
                "Failed to read {}: {error}",
                path.display()
            )));
        }
    };

    match serde_json::from_slice::<AgentUiState>(&bytes) {
        Ok(mut state) => {
            state.sanitize();
            Ok(state)
        }
        Err(error) => {
            eprintln!(
                "agent_chat_ui_state_corrupt path={} error={error}",
                path.display()
            );
            backup_corrupt(&path, &bytes);
            Ok(AgentUiState::default())
        }
    }
}

/// Persists `ui.json` atomically: temporary file, `sync_all`, then rename.
pub fn save(state: &AgentUiState) -> AgentChatResult<()> {
    let directory = paths::ensure_dir()?;
    let target = directory.join("ui.json");
    let temp = target.with_extension("json.tmp");

    let mut normalized = state.clone();
    normalized.sanitize();
    let json = serde_json::to_vec_pretty(&normalized)
        .map_err(|error| AgentChatError::internal(format!("Failed to serialize ui.json: {error}")))?;

    {
        let mut file = fs::File::create(&temp).map_err(|error| {
            AgentChatError::internal(format!("Failed to write {}: {error}", temp.display()))
        })?;
        file.write_all(&json).map_err(|error| {
            AgentChatError::internal(format!("Failed to write {}: {error}", temp.display()))
        })?;
        file.sync_all().map_err(|error| {
            AgentChatError::internal(format!("Failed to flush {}: {error}", temp.display()))
        })?;
    }

    fs::rename(&temp, &target).map_err(|error| {
        AgentChatError::internal(format!("Failed to replace {}: {error}", target.display()))
    })
}

fn backup_corrupt(path: &std::path::Path, bytes: &[u8]) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("ui.json.bak-{stamp}"));
    if let Err(error) = fs::write(&backup, bytes) {
        eprintln!(
            "agent_chat_ui_state_backup_failed path={} error={error}",
            backup.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_clamps_tabs_and_workspaces() {
        let mut state = AgentUiState::default();
        for index in 0..25 {
            state.open_tabs.push(crate::models::AgentTab {
                tab_id: format!("t{index}"),
                engine: "claude".to_string(),
                session_id: None,
                workspace_path: "E:\\work".to_string(),
            });
        }
        for index in 0..15 {
            state.recent_workspaces.push(format!("E:\\w{index}"));
        }
        state.recent_workspaces.push("E:\\w0".to_string());

        state.sanitize();

        assert_eq!(state.open_tabs.len(), 20);
        assert_eq!(state.recent_workspaces.len(), 10);
        assert_eq!(state.recent_workspaces[0], "E:\\w0");
    }

    #[test]
    fn default_state_names_the_three_engines() {
        let state = AgentUiState::default();
        assert_eq!(state.version, 1);
        assert_eq!(state.engines.len(), 3);
        assert_eq!(
            state.engines["claude"].permission.as_deref(),
            Some("manual")
        );
    }
}
