//! Batched event output.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 emits every push as a one-element array. B1 adds the 16 ms / 64 KB
//! batching behind the same three methods.

use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::models::AgentRunEvent;

pub const AGENT_EVENT_NAME: &str = "agent:event";

pub struct EventSink {
    app: tauri::AppHandle,
    pending: Mutex<Vec<AgentRunEvent>>,
}

impl EventSink {
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            pending: Mutex::new(Vec::new()),
        })
    }

    pub fn push(&self, event: AgentRunEvent) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.push(event);
        }
        self.flush();
    }

    pub fn flush(&self) {
        let batch = match self.pending.lock() {
            Ok(mut pending) if !pending.is_empty() => std::mem::take(&mut *pending),
            _ => return,
        };
        if let Err(error) = self.app.emit(AGENT_EVENT_NAME, batch) {
            eprintln!("agent_chat_event_emit_failed error={error}");
        }
    }
}
