// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Event names the backend emits and the page listens to.
//!
//! The prefix is `moin:` so the download events cannot collide with another
//! feature's channel. Progress is always emitted as a batch (`Vec<TaskProgress>`)
//! through the flusher in `state.rs`.

pub const TASK_ADDED: &str = "moin:task-added";
pub const TASK_UPDATED: &str = "moin:task-updated";
pub const TASK_REMOVED: &str = "moin:task-removed";
pub const TASK_PROGRESS: &str = "moin:task-progress";
pub const TASK_COMPLETED: &str = "moin:task-completed";
pub const SETTINGS_CHANGED: &str = "moin:settings-changed";
pub const CATEGORIES_CHANGED: &str = "moin:categories-changed";
