use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use super::{CoreError, CoreResult};

/// Stable diagnostic text used by callers that translate a native cancellation
/// back into a domain error.
pub(crate) const OPERATION_CANCELLED_ERROR: &str = "operation cancelled";

/// Identifies one class of cancellable Core operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CoordinatedOperationKind {
    CleanupScan,
    Analysis,
    LargeFiles,
    DuplicateFiles,
    ApplicationScan,
    ApplicationLeftoverScan,
    ApplicationPreparation,
    Applications,
    ApplicationLeftoverCleanup,
    ApplicationClose,
    Cleanup,
    PermanentDelete,
    StartupScan,
    StartupChange,
    SystemSettingsScan,
    SystemSettingsChange,
    SystemMaintenanceScan,
    SystemMaintenanceExecution,
    PrivacyScan,
    PrivacyExecution,
}

impl CoordinatedOperationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CleanupScan => "cleanup_scan",
            Self::Analysis => "analysis",
            Self::LargeFiles => "large_files",
            Self::DuplicateFiles => "duplicate_files",
            Self::ApplicationScan => "application_scan",
            Self::ApplicationLeftoverScan => "application_leftover_scan",
            Self::ApplicationPreparation => "application_preparation",
            Self::Applications => "applications",
            Self::ApplicationLeftoverCleanup => "application_leftover_cleanup",
            Self::ApplicationClose => "application_close",
            Self::Cleanup => "cleanup",
            Self::PermanentDelete => "permanent_delete",
            Self::StartupScan => "startup_scan",
            Self::StartupChange => "startup_change",
            Self::SystemSettingsScan => "system_settings_scan",
            Self::SystemSettingsChange => "system_settings_change",
            Self::SystemMaintenanceScan => "system_maintenance_scan",
            Self::SystemMaintenanceExecution => "system_maintenance_execution",
            Self::PrivacyScan => "privacy_scan",
            Self::PrivacyExecution => "privacy_execution",
        }
    }
}

/// Cancellation requests live in one process-wide registry until the operation
/// that owns them observes the request.
///
/// The full coordinator (resource claims and cross-process locks) belongs to the
/// service lanes; this registry keeps the public cancellation contract working
/// while the domain services are ported.
static CANCELLED: OnceLock<Mutex<BTreeSet<CoordinatedOperationKind>>> = OnceLock::new();

fn cancelled_kinds() -> &'static Mutex<BTreeSet<CoordinatedOperationKind>> {
    CANCELLED.get_or_init(|| Mutex::new(BTreeSet::new()))
}

/// Adapter-owned handle for cancelling one class of active Core operation.
///
/// The token contains no UI or terminal state. Desktop and CLI adapters can
/// therefore request cancellation through the same Core contract.
#[derive(Clone, Copy, Debug)]
pub struct OperationCancellationToken {
    kind: CoordinatedOperationKind,
}

impl OperationCancellationToken {
    pub const fn cleanup_scan() -> Self {
        Self {
            kind: CoordinatedOperationKind::CleanupScan,
        }
    }

    pub const fn analysis() -> Self {
        Self {
            kind: CoordinatedOperationKind::Analysis,
        }
    }

    pub const fn large_files() -> Self {
        Self {
            kind: CoordinatedOperationKind::LargeFiles,
        }
    }

    pub const fn duplicate_files() -> Self {
        Self {
            kind: CoordinatedOperationKind::DuplicateFiles,
        }
    }

    pub const fn cleanup() -> Self {
        Self {
            kind: CoordinatedOperationKind::Cleanup,
        }
    }

    pub const fn applications() -> Self {
        Self {
            kind: CoordinatedOperationKind::Applications,
        }
    }

    pub const fn application_leftover_cleanup() -> Self {
        Self {
            kind: CoordinatedOperationKind::ApplicationLeftoverCleanup,
        }
    }

    pub const fn application_scan() -> Self {
        Self {
            kind: CoordinatedOperationKind::ApplicationScan,
        }
    }

    pub const fn startup_scan() -> Self {
        Self {
            kind: CoordinatedOperationKind::StartupScan,
        }
    }

    pub const fn startup_change() -> Self {
        Self {
            kind: CoordinatedOperationKind::StartupChange,
        }
    }

    pub const fn system_settings_scan() -> Self {
        Self {
            kind: CoordinatedOperationKind::SystemSettingsScan,
        }
    }

    pub const fn system_maintenance_scan() -> Self {
        Self {
            kind: CoordinatedOperationKind::SystemMaintenanceScan,
        }
    }

    pub const fn privacy_scan() -> Self {
        Self {
            kind: CoordinatedOperationKind::PrivacyScan,
        }
    }

    pub const fn privacy_execution() -> Self {
        Self {
            kind: CoordinatedOperationKind::PrivacyExecution,
        }
    }

    pub fn cancel(self) {
        // An active operation owns a live flag; clear it and stop there so the
        // request cannot leak into the next run of the same kind.
        if let Ok(active) = active_operations().lock() {
            if let Some(operation) = active.get(&self.kind) {
                operation.cancelled.store(true, Ordering::Relaxed);
                log::info!(
                    "operation_cancel_requested operation_id={} operation_kind={}",
                    operation.id,
                    self.kind.as_str()
                );
                return;
            }
        }
        let Ok(mut cancelled) = cancelled_kinds().lock() else {
            log::warn!(
                "operation_cancel_failed operation_kind={} reason=registry_poisoned",
                self.kind.as_str()
            );
            return;
        };
        cancelled.insert(self.kind);
        log::info!(
            "operation_cancel_requested operation_kind={}",
            self.kind.as_str()
        );
    }
}

/// Returns whether cancellation was requested for `kind` and clears the
/// request, so a completed operation does not affect the next run.
pub(crate) fn take_cancellation(kind: CoordinatedOperationKind) -> bool {
    match cancelled_kinds().lock() {
        Ok(mut cancelled) => cancelled.remove(&kind),
        Err(_) => {
            log::warn!(
                "operation_cancel_check_failed operation_kind={} reason=registry_poisoned",
                kind.as_str()
            );
            false
        }
    }
}

/// Serializes tests that start coordinated operations.
///
/// Operations are exclusive per kind inside one process, so concurrently running
/// tests observe each other's claims. Tests hold this guard for their lifetime
/// instead of weakening the production contract.
#[cfg(test)]
pub(crate) fn test_operation_lock() -> std::sync::MutexGuard<'static, ()> {
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct ActiveOperation {
    id: u64,
    cancelled: Arc<AtomicBool>,
}

static ACTIVE: OnceLock<Mutex<BTreeMap<CoordinatedOperationKind, ActiveOperation>>> = OnceLock::new();
static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

fn active_operations() -> &'static Mutex<BTreeMap<CoordinatedOperationKind, ActiveOperation>> {
    ACTIVE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Owns one running operation's cancellation flag and identity.
///
/// The reference engine also serialized conflicting scans across threads and
/// processes. This port keeps the in-process contract the scan kernel needs:
/// one operation per kind, a live cancellation flag, and a stable operation id
/// used by progress events. Cross-process coordination belongs to the adapter
/// lane that starts those operations.
pub(crate) struct OperationGuard {
    id: u64,
    kind: CoordinatedOperationKind,
    cancelled: Arc<AtomicBool>,
    started: Instant,
}

impl OperationGuard {
    pub(crate) fn start(kind: CoordinatedOperationKind) -> CoreResult<Self> {
        if take_cancellation(kind) {
            return Err(CoreError::operation_cancelled());
        }
        let mut active = active_operations().lock().map_err(|_| {
            CoreError::operation_failed("the operation coordinator is temporarily unavailable")
        })?;
        if let Some(operation) = active.get(&kind) {
            return Err(CoreError::operation_busy(format!(
                "another operation is already running: {} ({})",
                kind.as_str(),
                operation.id
            )));
        }
        let id = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(
            kind,
            ActiveOperation {
                id,
                cancelled: Arc::clone(&cancelled),
            },
        );
        drop(active);
        log::info!(
            "operation_started operation_id={} operation_kind={}",
            id,
            kind.as_str()
        );
        Ok(Self {
            id,
            kind,
            cancelled,
            started: Instant::now(),
        })
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    pub(crate) fn cancelled(&self) -> &AtomicBool {
        self.cancelled.as_ref()
    }

    /// Background validation receives only the flag so a worker cannot extend
    /// guard ownership and keep the process lock alive accidentally.
    pub(crate) fn cancellation_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }

    pub(crate) fn ensure_not_cancelled(&self) -> CoreResult<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err(CoreError::operation_cancelled())
        } else {
            Ok(())
        }
    }

    pub(crate) fn complete(&self) {}

    /// Records a retryable platform condition separately from a failed operation
    /// so diagnostics do not report an expected backpressure decision as a warning.
    pub(crate) fn defer(&self) {}

    pub(crate) fn cancel(kind: CoordinatedOperationKind) {
        OperationCancellationToken { kind }.cancel();
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = active_operations().lock() {
            if active
                .get(&self.kind)
                .is_some_and(|operation| operation.id == self.id)
            {
                active.remove(&self.kind);
            }
        }
        log::info!(
            "operation_finished operation_id={} operation_kind={} cancelled={} elapsed_ms={}",
            self.id,
            self.kind.as_str(),
            self.cancelled.load(Ordering::Relaxed),
            self.started.elapsed().as_millis()
        );
    }
}
