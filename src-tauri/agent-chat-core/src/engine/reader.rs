//! Turn state and the event dispatch loop.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 only freezes the type names; B1 fills the dispatch, EOF settlement and
//! stdout parsing.

use std::sync::Arc;

use crate::engine::events::EngineEvent;
use crate::engine::sink::EventSink;

/// Per-run reader state. Owned by the reader task, so it needs no lock.
pub struct TurnState {
    pub run_id: String,
    pub engine: String,
    pub seq: u64,
    pub session_id: Option<String>,
}

impl TurnState {
    pub fn new(run_id: impl Into<String>, engine: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            engine: engine.into(),
            seq: 0,
            session_id: None,
        }
    }
}

/// Turns normalized events into `AgentRunEvent`s and hands them to the sink.
pub struct TurnCore {
    pub turn: TurnState,
}

impl TurnCore {
    pub fn new(turn: TurnState) -> Self {
        Self { turn }
    }

    /// A0 keeps this a no-op; B1 stamps `seq`, routes `session` back to the
    /// tab and settles the turn on `done`/`error`.
    pub fn dispatch_event(&mut self, sink: &Arc<EventSink>, event: EngineEvent) {
        let _ = (sink, event);
    }
}
