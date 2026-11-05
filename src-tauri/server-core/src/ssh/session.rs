//! Shell channel actor: reads the channel, forwards output as `server:output`
//! events, and bounds every write / disconnect so a dead peer cannot hang the
//! UI thread.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::SessionRegistry;
use crate::events;

/// Connect timeout from the plan (§3.1).
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Idle connections are reclaimed only after the last shell and transfer end.
pub(crate) const IDLE_RECLAIM: Duration = Duration::from_secs(5 * 60);

/// Drain one shell channel until the server closes it, then drop the session
/// from the registry and report the exit.
pub(crate) fn spawn_reader(
    app: Option<tauri::AppHandle>,
    session_id: String,
    mut read_half: russh::ChannelReadHalf,
    sessions: SessionRegistry,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut reason: Option<String> = None;

        while let Some(message) = read_half.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => emit_output(&app, &session_id, &data),
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    emit_output(&app, &session_id, &data)
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    reason = Some(format!("The shell exited with status {exit_status}."));
                }
                russh::ChannelMsg::ExitSignal {
                    signal_name,
                    error_message,
                    ..
                } => {
                    let detail = error_message.trim();
                    reason = Some(if detail.is_empty() {
                        format!("The shell was terminated by signal {signal_name:?}.")
                    } else {
                        format!("The shell was terminated by signal {signal_name:?}: {detail}")
                    });
                }
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }

        if let Ok(mut map) = sessions.lock() {
            map.remove(&session_id);
        }
        emit_exit(&app, &session_id, reason);
    })
}

/// Tell the window a session ended, with the reason the channel gave us.
pub(crate) fn emit_exit(app: &Option<tauri::AppHandle>, session_id: &str, reason: Option<String>) {
    let Some(app) = app else {
        return;
    };
    events::emit(
        app,
        events::SERVER_EXIT,
        events::ExitEvent {
            session_id: session_id.to_string(),
            reason,
        },
    );
}

fn emit_output(app: &Option<tauri::AppHandle>, session_id: &str, data: &[u8]) {
    let Some(app) = app else {
        return;
    };
    events::emit(
        app,
        events::SERVER_OUTPUT,
        events::OutputEvent {
            session_id: session_id.to_string(),
            data: STANDARD.encode(data),
        },
    );
}
