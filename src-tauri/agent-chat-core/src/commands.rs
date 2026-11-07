//! The nine `#[tauri::command]` entry points, one thin forwarder each.

pub mod engine;
pub mod history;
pub mod ui;

pub use engine::{
    agent_answer, agent_interrupt, agent_list_engines, agent_live_runs, agent_send,
};
pub use history::{agent_list_sessions, agent_load_session};
pub use ui::{agent_ui_get, agent_ui_set};
