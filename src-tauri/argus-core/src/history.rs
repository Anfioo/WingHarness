// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! History record, cleanup and query. Stub baseline: the `ARGH` v2 day files,
//! aggregation and corruption truncation land with the history port.
//!
//! History is the one deliberate exception to the JSON settings convention: a
//! week of five-second frames is too large for JSON, so the files live under
//! `<data dir>/argus/history`.

use std::io;
use std::path::{Path, PathBuf};

use crate::collector::Snapshot;
use crate::error::ArgusResult;
use crate::models::{HistoryMoment, HistoryPoint, HistoryUsage};
use crate::paths;

/// Length of one frame.
pub const FRAME_MS: i64 = 5_000;
/// Days of history kept.
pub const KEEP_DAYS: i64 = 7;

/// Appends frames to the day file of the moment they describe.
pub struct HistoryRecorder {
    dir: PathBuf,
}

impl HistoryRecorder {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Records one sample. A failed write is logged by the real implementation
    /// and never stops sampling.
    pub fn record(&mut self, _sample: &Snapshot) {}

    /// Closes the open day file and removes every recorded file.
    pub fn clear(&mut self) -> io::Result<()> {
        clear(&self.dir)
    }
}

/// `<data dir>/argus/history`; not created here.
pub fn dir() -> ArgusResult<PathBuf> {
    Ok(paths::dir()?.join("history"))
}

/// Removes day files older than the retention window.
pub fn prune_expired(_directory: &Path) {}

/// Removes every history file.
pub fn clear(_directory: &Path) -> io::Result<()> {
    Ok(())
}

/// Size of all day files and the oldest recorded frame.
pub fn usage(_directory: &Path) -> HistoryUsage {
    HistoryUsage::default()
}

/// The first and last recorded timestamps, when any exist.
pub fn range(_directory: &Path) -> Option<(i64, i64)> {
    None
}

/// Aggregates the recorded frames between `from` and `to` into `buckets`.
pub fn series(_directory: &Path, _from: i64, _to: i64, _buckets: usize) -> Vec<HistoryPoint> {
    Vec::new()
}

/// The frame closest to `ts`, with the processes that stood out in it.
pub fn moment(_directory: &Path, _ts: i64) -> Option<HistoryMoment> {
    None
}
