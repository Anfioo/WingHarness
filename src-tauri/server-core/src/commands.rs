//! The 38 Tauri commands of the server manager.
//!
//! Every function here is a thin forwarder: argument decoding, then straight to
//! the matching module. Domain work lives in `ssh/`, `sftp/`, `local_fs`,
//! `secrets` and `host_keys`; nothing in this file may hold state of its own.

pub(crate) mod local;
pub(crate) mod profiles;
pub(crate) mod sftp;
pub(crate) mod ssh;
pub(crate) mod transfer;

use base64::Engine as _;

use crate::error::{ServerError, ServerResult};
use crate::models::{
    ConflictPolicy, ConnectOutcome, HostKeyRecord, MetricsSample, SecretKind, ServerPrefs,
    ServerProfile, ServerProfileInput, ServerProfilesView, SessionInfo, SftpEntry,
    TransferDirection, TransferSnapshot,
};
use crate::ssh::ConnectionState;
use crate::ServerState;

// Profiles.

#[tauri::command]
pub async fn server_profiles_list(
    state: tauri::State<'_, ServerState>,
) -> ServerResult<ServerProfilesView> {
    profiles::list(&state).await
}

#[tauri::command]
pub async fn server_profile_create(
    state: tauri::State<'_, ServerState>,
    input: ServerProfileInput,
) -> ServerResult<ServerProfile> {
    profiles::create(&state, input).await
}

#[tauri::command]
pub async fn server_profile_update(
    state: tauri::State<'_, ServerState>,
    id: String,
    input: ServerProfileInput,
) -> ServerResult<ServerProfile> {
    profiles::update(&state, &id, input).await
}

#[tauri::command]
pub async fn server_profile_delete(
    state: tauri::State<'_, ServerState>,
    id: String,
) -> ServerResult<()> {
    profiles::delete(&state, &id).await
}

#[tauri::command]
pub async fn server_profile_reorder(
    state: tauri::State<'_, ServerState>,
    ids: Vec<String>,
) -> ServerResult<()> {
    profiles::reorder(&state, ids).await
}

// Credentials.

#[tauri::command]
pub async fn server_secret_set(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    kind: SecretKind,
    value: String,
) -> ServerResult<()> {
    profiles::secret_set(&state, &profile_id, kind, &value).await
}

#[tauri::command]
pub async fn server_secret_clear(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    kind: SecretKind,
) -> ServerResult<()> {
    profiles::secret_clear(&state, &profile_id, kind).await
}

// Host keys.

#[tauri::command]
pub async fn server_host_key_get(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
) -> ServerResult<Option<HostKeyRecord>> {
    profiles::host_key_get(&state, &profile_id).await
}

#[tauri::command]
pub async fn server_host_key_forget(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
) -> ServerResult<()> {
    profiles::host_key_forget(&state, &profile_id).await
}

#[tauri::command]
pub async fn server_host_key_trust_pending(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    fingerprint: String,
) -> ServerResult<()> {
    profiles::host_key_trust_pending(&state, &profile_id, &fingerprint).await
}

// Preferences.

#[tauri::command]
pub async fn server_prefs_get(state: tauri::State<'_, ServerState>) -> ServerResult<ServerPrefs> {
    profiles::prefs_get(&state).await
}

#[tauri::command]
pub async fn server_prefs_set(
    state: tauri::State<'_, ServerState>,
    prefs: ServerPrefs,
) -> ServerResult<ServerPrefs> {
    profiles::prefs_set(&state, prefs).await
}

// SSH sessions.

#[tauri::command]
pub async fn server_connect(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    cols: u16,
    rows: u16,
    trust_host_key: bool,
) -> ServerResult<ConnectOutcome> {
    ssh::connect(&state, &profile_id, cols, rows, trust_host_key).await
}

#[tauri::command]
pub async fn server_write(
    state: tauri::State<'_, ServerState>,
    session_id: String,
    data: String,
) -> ServerResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| ServerError::internal("The terminal payload is not valid base64."))?;
    ssh::write(&state, &session_id, &bytes).await
}

#[tauri::command]
pub async fn server_resize(
    state: tauri::State<'_, ServerState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> ServerResult<()> {
    ssh::resize(&state, &session_id, cols, rows).await
}

#[tauri::command]
pub async fn server_disconnect(
    state: tauri::State<'_, ServerState>,
    session_id: String,
) -> ServerResult<()> {
    ssh::disconnect(&state, &session_id).await
}

#[tauri::command]
pub async fn server_connection_close(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
) -> ServerResult<()> {
    ssh::connection_close(&state, &profile_id).await
}

#[tauri::command]
pub fn server_sessions_list(state: tauri::State<'_, ServerState>) -> ServerResult<Vec<SessionInfo>> {
    Ok(ssh::sessions(&state))
}

#[tauri::command]
pub fn server_connection_state(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
) -> ServerResult<ConnectionState> {
    Ok(ssh::connection_state(&state, &profile_id))
}

#[tauri::command]
pub fn server_metrics_history(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
) -> ServerResult<Vec<MetricsSample>> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err(ServerError::not_found(profile_id));
    }
    Ok(state.connections.metrics_history(profile_id))
}

// Remote files.

#[tauri::command]
pub async fn server_sftp_home(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
) -> ServerResult<String> {
    sftp::home(&state, &profile_id).await
}

#[tauri::command]
pub async fn server_sftp_list(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    path: String,
) -> ServerResult<Vec<SftpEntry>> {
    sftp::list(&state, &profile_id, &path).await
}

#[tauri::command]
pub async fn server_sftp_stat(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    path: String,
) -> ServerResult<SftpEntry> {
    sftp::stat(&state, &profile_id, &path).await
}

#[tauri::command]
pub async fn server_sftp_mkdir(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    path: String,
) -> ServerResult<()> {
    sftp::mkdir(&state, &profile_id, &path).await
}

#[tauri::command]
pub async fn server_sftp_rename(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    from: String,
    to: String,
) -> ServerResult<()> {
    sftp::rename(&state, &profile_id, &from, &to).await
}

#[tauri::command]
pub async fn server_sftp_delete(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    path: String,
    is_dir: bool,
) -> ServerResult<()> {
    sftp::delete(&state, &profile_id, &path, is_dir).await
}

#[tauri::command]
pub async fn server_sftp_read_text(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    path: String,
) -> ServerResult<String> {
    sftp::read_text(&state, &profile_id, &path).await
}

#[tauri::command]
pub async fn server_sftp_write_text(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    path: String,
    content: String,
) -> ServerResult<()> {
    sftp::write_text(&state, &profile_id, &path, &content).await
}

// Local files.

#[tauri::command]
pub async fn server_local_home() -> ServerResult<String> {
    local::home().await
}

#[tauri::command]
pub async fn server_local_list(
    path: String,
    show_hidden: bool,
) -> ServerResult<Vec<SftpEntry>> {
    local::list(&path, show_hidden).await
}

#[tauri::command]
pub async fn server_local_mkdir(path: String) -> ServerResult<()> {
    local::mkdir(&path).await
}

#[tauri::command]
pub async fn server_local_rename(from: String, to: String) -> ServerResult<()> {
    local::rename(&from, &to).await
}

#[tauri::command]
pub async fn server_local_delete(path: String, is_dir: bool) -> ServerResult<()> {
    local::delete(&path, is_dir).await
}

// Transfers.

#[tauri::command]
pub async fn server_transfer_start(
    state: tauri::State<'_, ServerState>,
    profile_id: String,
    direction: TransferDirection,
    sources: Vec<String>,
    target_dir: String,
    conflict_policy: ConflictPolicy,
) -> ServerResult<Vec<String>> {
    transfer::start(
        &state,
        &profile_id,
        direction,
        sources,
        &target_dir,
        conflict_policy,
    )
    .await
}

#[tauri::command]
pub async fn server_transfer_pause(transfer_id: String) -> ServerResult<()> {
    transfer::pause(&transfer_id).await
}

#[tauri::command]
pub async fn server_transfer_resume(
    state: tauri::State<'_, ServerState>,
    transfer_id: String,
) -> ServerResult<()> {
    transfer::resume(&state, &transfer_id).await
}

#[tauri::command]
pub async fn server_transfer_cancel(transfer_id: String) -> ServerResult<()> {
    transfer::cancel(&transfer_id).await
}

#[tauri::command]
pub fn server_transfer_list() -> ServerResult<Vec<TransferSnapshot>> {
    transfer::list()
}
