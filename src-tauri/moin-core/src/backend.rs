// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Transfer backends and the control handle the queue uses to stop one.
//!
//! The engine never talks to a concrete backend type: it hands the task, the
//! transfer options and a [`Control`] to a [`DownloadBackend`] and gets an
//! [`Outcome`] back. The embedded HTTP path and the aria2c path both fit that
//! shape, which is what keeps the queue free of engine-specific branches.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use crate::models::{BackendInfo, Task, TaskKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Signal {
    #[default]
    Run = 0,
    Pause = 1,
    Cancel = 2,
}

#[derive(Debug, Default)]
struct ControlState(Mutex<Signal>);

impl ControlState {
    fn set(&self, signal: Signal) {
        if let Ok(mut current) = self.0.lock() {
            *current = signal;
        }
    }

    fn get(&self) -> Signal {
        self.0.lock().map(|signal| *signal).unwrap_or(Signal::Cancel)
    }
}

/// Shared, cloneable control channel: the queue keeps one handle and the
/// transfer loop polls the other. A poisoned lock is treated as `Cancel` so a
/// panicking worker cannot leave a task running forever.
#[derive(Debug, Clone, Default)]
pub struct Control(Arc<ControlState>);

impl Control {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, signal: Signal) {
        self.0.set(signal);
    }

    pub fn signal(&self) -> Signal {
        self.0.get()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TransferOpts {
    pub connections: usize,
    pub min_split_size: u64,
    pub hide_part: bool,
    pub stall_timeout: Duration,
}

#[derive(Debug, Clone, Copy)]
pub struct NetConfig {
    pub connect_timeout: Option<Duration>,
}

#[derive(Debug)]
pub enum Outcome {
    Completed,
    Paused,
    Canceled,
    Stalled,
    Failed(String),
}

pub type ProgressFn = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;

#[async_trait]
pub trait DownloadBackend: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn supports(&self, kind: TaskKind) -> bool;
    fn available(&self) -> bool {
        true
    }
    fn reconfigure(&self, _net: NetConfig) {}
    async fn run(
        &self,
        task: Task,
        opts: TransferOpts,
        control: Control,
        progress: ProgressFn,
    ) -> Outcome;
    async fn shutdown(&self) {}
}

impl BackendInfo {
    pub fn of(backend: &dyn DownloadBackend) -> Self {
        Self {
            id: backend.id().to_string(),
            label: backend.label().to_string(),
            http: backend.supports(TaskKind::Http),
            available: backend.available(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Control, Signal};

    #[test]
    fn control_defaults_to_run_and_keeps_the_last_signal() {
        let control = Control::new();
        assert_eq!(control.signal(), Signal::Run);
        let clone = control.clone();
        clone.set(Signal::Pause);
        assert_eq!(control.signal(), Signal::Pause);
        control.set(Signal::Cancel);
        assert_eq!(clone.signal(), Signal::Cancel);
    }
}
