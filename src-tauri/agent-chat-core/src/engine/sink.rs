//! Batched event output.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Every `agent:event` payload is a JSON array. Events accumulate for at most
//! 16 ms or 64 KB, then one flush emits the whole batch, so a streaming turn
//! costs one IPC message per frame instead of one per token.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Emitter;

use crate::models::AgentRunEvent;

pub const AGENT_EVENT_NAME: &str = "agent:event";

const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_BYTES: usize = 64 * 1024;

struct Pending {
    events: Vec<AgentRunEvent>,
    bytes: usize,
    scheduled: bool,
}

pub struct EventSink {
    /// `None` only for the unit-test sink, which records batches in `outbox`.
    app: Option<tauri::AppHandle>,
    pending: Arc<Mutex<Pending>>,
    outbox: Arc<Mutex<Vec<Vec<AgentRunEvent>>>>,
}

impl EventSink {
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app: Some(app),
            pending: Arc::new(Mutex::new(Pending {
                events: Vec::new(),
                bytes: 0,
                scheduled: false,
            })),
            outbox: Arc::new(Mutex::new(Vec::new())),
        })
    }

    #[cfg(test)]
    pub(crate) fn new_for_test() -> Arc<Self> {
        Arc::new(Self {
            app: None,
            pending: Arc::new(Mutex::new(Pending {
                events: Vec::new(),
                bytes: 0,
                scheduled: false,
            })),
            outbox: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Serialize once for the size budget, queue, and arm the timer.
    pub fn push(&self, event: AgentRunEvent) {
        let bytes = serde_json::to_string(&event)
            .map(|json| json.len())
            .unwrap_or(0);
        let mut flush_now = false;
        {
            let Ok(mut pending) = self.pending.lock() else {
                return;
            };
            pending.bytes += bytes;
            pending.events.push(event);
            if pending.bytes >= FLUSH_BYTES {
                flush_now = true;
            } else if !pending.scheduled && self.app.is_some() {
                pending.scheduled = true;
                let batch = Arc::clone(&self.pending);
                let outbox = Arc::clone(&self.outbox);
                let app = self.app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(FLUSH_INTERVAL).await;
                    flush_batch(app.as_ref(), &batch, &outbox);
                });
            }
        }
        if flush_now {
            self.flush();
        }
    }

    pub fn flush(&self) {
        flush_batch(self.app.as_ref(), &self.pending, &self.outbox);
    }

    #[cfg(test)]
    pub(crate) fn take_batches(&self) -> Vec<Vec<AgentRunEvent>> {
        match self.outbox.lock() {
            Ok(mut outbox) => std::mem::take(&mut *outbox),
            Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
        }
    }
}

fn flush_batch(
    app: Option<&tauri::AppHandle>,
    pending: &Mutex<Pending>,
    outbox: &Mutex<Vec<Vec<AgentRunEvent>>>,
) {
    let batch = {
        let Ok(mut pending) = pending.lock() else {
            return;
        };
        pending.scheduled = false;
        pending.bytes = 0;
        std::mem::take(&mut pending.events)
    };
    if batch.is_empty() {
        return;
    }
    match app {
        Some(app) => {
            if let Err(error) = app.emit(AGENT_EVENT_NAME, batch) {
                eprintln!("agent_chat_event_emit_failed error={error}");
            }
        }
        None => {
            if let Ok(mut outbox) = outbox.lock() {
                outbox.push(batch);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(seq: u64, text: &str) -> AgentRunEvent {
        AgentRunEvent {
            run_id: "run-1".to_string(),
            session_id: None,
            engine: "claude".to_string(),
            seq,
            kind: "delta".to_string(),
            data: serde_json::Value::String(text.to_string()),
            ts: 0,
        }
    }

    #[test]
    fn small_batches_wait_for_an_explicit_flush() {
        let sink = EventSink::new_for_test();
        sink.push(event(1, "a"));
        sink.push(event(2, "b"));
        assert!(sink.take_batches().is_empty());

        sink.flush();
        let batches = sink.take_batches();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 2);
        assert_eq!(batches[0][1].seq, 2);
    }

    #[test]
    fn the_byte_budget_flushes_immediately() {
        let sink = EventSink::new_for_test();
        sink.push(event(1, &"x".repeat(FLUSH_BYTES)));

        let batches = sink.take_batches();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 1);
    }
}
