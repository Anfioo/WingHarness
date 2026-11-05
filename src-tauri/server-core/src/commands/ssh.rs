//! Interactive shell commands. Every one of them goes through the connection
//! pool; no protocol work happens here.

use crate::error::{ServerError, ServerResult};
use crate::models::{ConnectOutcome, SessionInfo};
use crate::ssh::ConnectionState;
use crate::ServerState;

/// Largest terminal payload one `server_write` call may carry.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const FALLBACK_COLS: u16 = 80;
const FALLBACK_ROWS: u16 = 24;

pub(crate) async fn connect(
    state: &ServerState,
    profile_id: &str,
    cols: u16,
    rows: u16,
    trust_host_key: bool,
) -> ServerResult<ConnectOutcome> {
    // Output events go through the manager, which has no other way to reach
    // the window.
    state.connections.attach_app(state.app.clone());
    state
        .connections
        .connect_shell(
            profile_id,
            if cols == 0 { FALLBACK_COLS } else { cols },
            if rows == 0 { FALLBACK_ROWS } else { rows },
            trust_host_key,
        )
        .await
}

pub(crate) async fn write(
    state: &ServerState,
    session_id: &str,
    data: &[u8],
) -> ServerResult<()> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(ServerError::file_too_large(
            data.len() as u64,
            MAX_WRITE_BYTES as u64,
        ));
    }
    state.connections.write(session_id, data).await
}

pub(crate) async fn resize(
    state: &ServerState,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> ServerResult<()> {
    state
        .connections
        .resize(
            session_id,
            cols.max(1),
            rows.max(1),
        )
        .await
}

pub(crate) async fn disconnect(state: &ServerState, session_id: &str) -> ServerResult<()> {
    state.connections.disconnect(session_id).await
}

pub(crate) async fn connection_close(state: &ServerState, profile_id: &str) -> ServerResult<()> {
    state.connections.close_profile(profile_id).await
}

pub(crate) fn sessions(state: &ServerState) -> Vec<SessionInfo> {
    state.connections.sessions()
}

pub(crate) fn connection_state(state: &ServerState, profile_id: &str) -> ConnectionState {
    state.connections.state(profile_id)
}
