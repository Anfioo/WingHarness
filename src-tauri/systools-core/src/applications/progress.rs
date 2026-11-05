//! Coarse progress for the application inventory and leftover lanes.
//!
//! The registry, PowerShell, and process phases cannot report intra-phase
//! counts, so the reporters advance at phase boundaries; only the
//! per-application assembly loop and the leftover directory walk report items.
//! One event per boundary keeps the IPC cost negligible.

use std::time::Instant;

use crate::applications::models::{
    ApplicationLeftoverScanProgress, ApplicationLeftoverScanStage, ApplicationScanProgress,
    ApplicationScanStage,
};

pub(crate) type ApplicationProgressSink<'a> = &'a dyn Fn(ApplicationScanProgress);
pub(crate) type LeftoverProgressSink<'a> = &'a dyn Fn(ApplicationLeftoverScanProgress);

/// Reports application-scan stages against one shared clock.
pub(crate) struct ApplicationScanProgressReporter<'a> {
    sink: ApplicationProgressSink<'a>,
    started: Instant,
}

impl<'a> ApplicationScanProgressReporter<'a> {
    pub(crate) fn new(sink: ApplicationProgressSink<'a>) -> Self {
        Self {
            sink,
            started: Instant::now(),
        }
    }

    pub(crate) fn report(&self, stage: ApplicationScanStage, percent: u8) {
        self.report_items(stage, percent, 0, None, None);
    }

    pub(crate) fn report_items(
        &self,
        stage: ApplicationScanStage,
        percent: u8,
        items_scanned: u64,
        items_total: Option<u64>,
        current_path: Option<String>,
    ) {
        (self.sink)(ApplicationScanProgress {
            stage,
            percent: percent.min(100),
            items_scanned,
            items_total,
            current_path,
            elapsed_ms: elapsed_millis(self.started),
        });
    }
}

/// Reports leftover-scan stages against one shared clock.
pub(crate) struct LeftoverScanProgressReporter<'a> {
    sink: LeftoverProgressSink<'a>,
    started: Instant,
}

impl<'a> LeftoverScanProgressReporter<'a> {
    pub(crate) fn new(sink: LeftoverProgressSink<'a>) -> Self {
        Self {
            sink,
            started: Instant::now(),
        }
    }

    pub(crate) fn report(&self, stage: ApplicationLeftoverScanStage, percent: u8) {
        self.report_items(stage, percent, 0, None, None);
    }

    pub(crate) fn report_items(
        &self,
        stage: ApplicationLeftoverScanStage,
        percent: u8,
        items_scanned: u64,
        items_total: Option<u64>,
        current_path: Option<String>,
    ) {
        (self.sink)(ApplicationLeftoverScanProgress {
            stage,
            percent: percent.min(100),
            items_scanned,
            items_total,
            current_path,
            elapsed_ms: elapsed_millis(self.started),
        });
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    started
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
