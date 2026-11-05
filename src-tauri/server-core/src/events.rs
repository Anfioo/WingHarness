//! Event names and payloads shared with the server-manager window.

use serde::Serialize;

/// Terminal output chunk: `{ sessionId, data }`, `data` is base64.
pub const SERVER_OUTPUT: &str = "server:output";
/// One shell ended: `{ sessionId, reason }`.
pub const SERVER_EXIT: &str = "server:exit";
/// Throttled transfer progress (100 ms): `TransferProgressEvent`.
pub const SERVER_TRANSFER_PROGRESS: &str = "server:transfer-progress";
/// A transfer reached a terminal state: `TransferDoneEvent`.
pub const SERVER_TRANSFER_DONE: &str = "server:transfer-done";
/// One metrics sample: `{ profileId, sample }`.
pub const SERVER_METRICS: &str = "server:metrics";
/// Frontend-only: the picker asks the window to open one profile.
pub const SERVER_OPEN_PROFILE: &str = "server-open-profile";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputEvent {
    pub session_id: String,
    /// base64 of the raw bytes read from the channel.
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitEvent {
    pub session_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressEvent {
    pub transfer_id: String,
    pub profile_id: String,
    pub transferred: u64,
    pub total: u64,
    pub bytes_per_sec: u64,
    pub state: crate::models::TransferState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDoneEvent {
    pub transfer_id: String,
    pub state: crate::models::TransferState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsEvent {
    pub profile_id: String,
    pub sample: crate::models::MetricsSample,
}

/// Emit one typed event and keep delivery failures in the native log: a closed
/// window must not turn a finished domain operation into a failure.
pub fn emit<S>(app: &tauri::AppHandle, event: &'static str, payload: S)
where
    S: Serialize + Clone,
{
    use tauri::Emitter;

    if let Err(error) = app.emit(event, payload) {
        log::warn!("server_event_emit_failed event={event} error={error}");
    }
}
