//! Combines system, hardware and process sampling into one snapshot.

use serde::Serialize;

use crate::hardware::Hardware;
use crate::process::ProcessRow;
use crate::system::SystemStats;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub seq: u64,
    /// Unix ms when the sample was taken.
    pub timestamp: i64,
    pub system: SystemStats,
    pub hardware: Hardware,
    pub processes: Vec<ProcessRow>,
    /// Per-process network traffic is measured, locally or by the service.
    pub process_network: bool,
}

/// Owns the per-source trackers of a sampling run. A0 only freezes the type;
/// B1 replaces the implementation with the ported trackers.
#[derive(Debug, Default)]
pub struct Collector {
    seq: u64,
}

impl Collector {
    /// Creates a collector and takes a priming sample, so the first real
    /// snapshot already has meaningful rates.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sample(&mut self) -> Snapshot {
        let _ = self.seq;
        todo!("snapshot sampling is implemented by B1")
    }
}
