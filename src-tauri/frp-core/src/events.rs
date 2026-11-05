//! Event names and payloads shared with the FRP page.
//!
//! `state` fires only when a process changes state and carries the full
//! snapshot; `metrics` fires every couple of seconds while a process runs and
//! carries only latency and tunnel states; `log` carries one line at a time.

use serde::Serialize;

use crate::models::{ConnectionSnapshot, LogEntry, TunnelRuntimeState};

/// `frp:state` — payload: the full `ConnectionSnapshot`.
pub const FRP_STATE: &str = "frp:state";
/// `frp:metrics` — payload: `MetricsEvent`.
pub const FRP_METRICS: &str = "frp:metrics";
/// `frp:log` — payload: `LogEntry`.
pub const FRP_LOG: &str = "frp:log";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsEvent {
    pub profile_id: String,
    #[serde(default)]
    pub latency_ms: Option<u32>,
    #[serde(default)]
    pub tunnel_states: Vec<TunnelRuntimeState>,
}

/// Emit one typed event and keep delivery failures in the native log: a closed
/// window must not turn a finished domain operation into a failure.
pub fn emit<S>(app: &tauri::AppHandle, event: &'static str, payload: S)
where
    S: Serialize + Clone,
{
    use tauri::Emitter;

    if let Err(error) = app.emit(event, payload) {
        log::warn!("frp_event_emit_failed event={event} error={error}");
    }
}

pub fn emit_state(app: &tauri::AppHandle, snapshot: &ConnectionSnapshot) {
    emit(app, FRP_STATE, snapshot.clone());
}

pub fn emit_metrics(app: &tauri::AppHandle, event: &MetricsEvent) {
    emit(app, FRP_METRICS, event.clone());
}

pub fn emit_log(app: &tauri::AppHandle, entry: &LogEntry) {
    emit(app, FRP_LOG, entry.clone());
}
