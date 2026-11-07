//! Normalized engine events.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! A0 keeps the event vocabulary minimal; B1 grows it together with the
//! reader. The `kind` strings are the ones frozen in plan §6.2.

/// One normalized event before it is stamped with run/session/seq.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineEvent {
    /// delta | thinking | message | session | usage | model | effort |
    /// permission_denied | question | question_settled | warn | retry |
    /// compaction | error | done | turn_resumed
    pub kind: String,
    pub data: serde_json::Value,
}

impl EngineEvent {
    pub fn new(kind: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            kind: kind.into(),
            data,
        }
    }

    /// A string-payload event (`delta`, `thinking`, `warn`, `error`, ...).
    pub fn text(kind: impl Into<String>, text: impl Into<String>) -> Self {
        Self::new(kind, serde_json::Value::String(text.into()))
    }
}

/// The event kinds this build emits. Kept next to the type so the reader and
/// the adapters cannot drift from the frontend's union.
pub const EVENT_KINDS: &[&str] = &[
    "delta",
    "thinking",
    "message",
    "session",
    "usage",
    "model",
    "effort",
    "permission_denied",
    "question",
    "question_settled",
    "warn",
    "retry",
    "compaction",
    "error",
    "done",
    "turn_resumed",
];
