//! Platform-side startup contracts shared by the Windows adapters and the
//! product-level aggregation.
//!
//! The contract intentionally excludes product grouping, localized text, and
//! change recommendations. Core owns those decisions while each platform
//! preserves the native source semantics needed to explain and later
//! revalidate an item.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use crate::{
    platform::contracts::PlatformResult,
    shared::operation::{take_cancellation, CoordinatedOperationKind},
};

/// Operating-system facts required by the startup domain.
pub(crate) trait StartupPlatform: Send + Sync {
    fn scan_startup_sources(
        &self,
        cancellation: &StartupCancellation,
        progress: &dyn StartupScanProgress,
    ) -> PlatformResult<Vec<PlatformStartupSourceResult>>;

    /// Changes one item resolved from a server-owned catalog session.
    ///
    /// Implementations must re-read the native item, reject state drift,
    /// perform the smallest source-specific mutation, and verify the resulting
    /// configured state before returning.
    fn change_startup_item(
        &self,
        request: &PlatformStartupChangeRequest,
        authorization_prompt: Option<&str>,
    ) -> PlatformResult<PlatformStartupChangeResult>;

    /// Changes a prepared batch while preserving an individual result for every request.
    fn change_startup_items(
        &self,
        requests: &[PlatformStartupChangeRequest],
        authorization_prompt: Option<&str>,
    ) -> PlatformResult<Vec<PlatformResult<PlatformStartupChangeResult>>> {
        Ok(requests
            .iter()
            .map(|request| self.change_startup_item(request, authorization_prompt))
            .collect())
    }
}

/// Receives one notification per startup source that finishes during a scan.
///
/// Sources scan in parallel, so the order of notifications is the order in
/// which sources complete, not the order in which they were started.
pub(crate) trait StartupScanProgress: Send + Sync {
    fn source_finished(&self, progress: StartupSourceScanProgress);
}

/// A scan that runs without a UI keeps the same code path with this sink.
pub(crate) struct SilentStartupScanProgress;

impl StartupScanProgress for SilentStartupScanProgress {
    fn source_finished(&self, _progress: StartupSourceScanProgress) {}
}

pub(crate) fn silent_scan_progress() -> SilentStartupScanProgress {
    SilentStartupScanProgress
}

/// One completed source, as reported to the desktop layer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupSourceScanProgress {
    pub source_id: String,
    pub status: PlatformStartupCoverageStatus,
    /// Startup items found so far across every finished source.
    pub items_found: u64,
    pub completed_sources: u64,
    pub total_sources: u64,
    pub elapsed_ms: u64,
}

/// Process-wide cancellation handle for one startup operation.
///
/// The shared registry only carries a one-shot request, so the handle latches
/// the first observation and keeps reporting cancellation for the rest of the
/// operation even when sources poll it many times.
#[derive(Clone)]
pub(crate) struct StartupCancellation {
    kind: CoordinatedOperationKind,
    cancelled: Arc<AtomicBool>,
}

impl StartupCancellation {
    pub(crate) fn scan() -> Self {
        Self::new(CoordinatedOperationKind::StartupScan)
    }

    /// Observes the cancellation flag owned by the active operation guard.
    ///
    /// The shared registry only receives a request when no operation is running;
    /// while a scan is active the token sets the guard's flag directly, so the
    /// adapter must read that same flag to observe a mid-scan cancellation.
    pub(crate) fn scan_with_flag(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            kind: CoordinatedOperationKind::StartupScan,
            cancelled,
        }
    }

    pub(crate) fn change() -> Self {
        Self::new(CoordinatedOperationKind::StartupChange)
    }

    fn new(kind: CoordinatedOperationKind) -> Self {
        Self {
            kind,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        if self.cancelled.load(Ordering::Relaxed) {
            return true;
        }
        if take_cancellation(self.kind) {
            self.cancelled.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    /// Clears a latched cancellation so a later operation is not stopped by a
    /// request that was consumed by an operation which already finished.
    pub(crate) fn reset(&self) {
        self.cancelled.store(false, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupDesiredState {
    Enabled,
    Disabled,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformStartupChangeRequest {
    /// Stable provider identifier retained only in the Core catalog session.
    pub provider_item_id: String,
    pub source_id: String,
    /// Complete native fact snapshot captured during preflight.
    pub expected_artifact: PlatformStartupArtifact,
    pub desired_state: PlatformStartupDesiredState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformStartupChangeResult {
    pub previous_state: PlatformStartupConfiguredState,
    pub configured_state: PlatformStartupConfiguredState,
    pub verified: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupSourceKind {
    RegistryRun,
    StartupFolder,
    ScheduledTask,
    Service,
    PackagedStartupTask,
    AdvancedAutoRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupScope {
    CurrentUser,
    User,
    AllUsers,
    Machine,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum PlatformStartupTrigger {
    Boot,
    UserLogon,
    Scheduled,
    Event,
    KeepAlive,
    ShellLoad,
    ApplicationLaunch,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupConfiguredState {
    Enabled,
    Disabled,
    Unknown,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupRuntimeState {
    Running,
    Stopped,
    Loaded,
    Unloaded,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupControlCapability {
    Toggleable,
    ElevationRequired,
    RemoveOnly,
    SystemManaged,
    PolicyManaged,
    ViewOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupTrustState {
    System,
    Verified,
    Invalid,
    Unsigned,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupIdentityConfidence {
    Exact,
    Strong,
    Probable,
    Unresolved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupSummarySource {
    ServiceDescription,
    TaskDescription,
    PackageManifest,
    VersionInfo,
    SourceLabel,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupTargetKind {
    Executable,
    Application,
    Script,
    Service,
    Task,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupDiagnosticCode {
    AccessDenied,
    InvalidData,
    MissingIdentity,
    MissingTarget,
    StateUnavailable,
    UnsupportedFormat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformStartupTarget {
    pub kind: PlatformStartupTargetKind,
    /// Provider-normalized identity used only as grouping evidence inside Core.
    pub identity_key: String,
    pub path: Option<PathBuf>,
    pub executable_name: Option<String>,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformStartupOwner {
    /// Strong platform identity such as a package family name.
    pub identity_key: Option<String>,
    pub name: Option<String>,
    pub publisher: Option<String>,
    pub summary: Option<String>,
    pub summary_source: PlatformStartupSummarySource,
    pub version: Option<String>,
    pub icon_path: Option<PathBuf>,
    pub confidence: PlatformStartupIdentityConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformStartupArtifact {
    /// Provider-owned stable identity used for mutation authority.
    pub provider_item_id: String,
    pub source_kind: PlatformStartupSourceKind,
    pub scope: PlatformStartupScope,
    pub triggers: Vec<PlatformStartupTrigger>,
    pub display_name: String,
    /// Path to the file that defines the startup behavior, when the provider has one.
    pub configuration_path: Option<PathBuf>,
    pub target: PlatformStartupTarget,
    pub owner: PlatformStartupOwner,
    pub configured_state: PlatformStartupConfiguredState,
    pub runtime_state: PlatformStartupRuntimeState,
    pub control_capability: PlatformStartupControlCapability,
    pub trust: PlatformStartupTrustState,
    pub modified_at_ms: Option<u64>,
    pub diagnostics: Vec<PlatformStartupDiagnosticCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlatformStartupCoverageStatus {
    Complete,
    Partial,
    Unavailable,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlatformStartupCoverageReason {
    AccessDenied,
    ApiUnavailable,
    Cancelled,
    InvalidData,
    NotImplemented,
    StateUnavailable,
    UnsupportedOperatingSystem,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformStartupSourceResult {
    pub source_id: String,
    pub required: bool,
    pub status: PlatformStartupCoverageStatus,
    pub reason: Option<PlatformStartupCoverageReason>,
    pub items: Vec<PlatformStartupArtifact>,
    pub elapsed_ms: u64,
}

impl PlatformStartupSourceResult {
    pub(crate) fn unavailable(
        source_id: impl Into<String>,
        required: bool,
        reason: PlatformStartupCoverageReason,
    ) -> Self {
        Self {
            source_id: source_id.into(),
            required,
            status: PlatformStartupCoverageStatus::Unavailable,
            reason: Some(reason),
            items: Vec::new(),
            elapsed_ms: 0,
        }
    }
}

#[cfg(windows)]
pub(crate) fn current_platform() -> &'static dyn StartupPlatform {
    crate::platform::windows::startup::platform()
}

#[cfg(not(windows))]
pub(crate) fn current_platform() -> &'static dyn StartupPlatform {
    struct Unsupported;

    impl StartupPlatform for Unsupported {
        fn scan_startup_sources(
            &self,
            _cancellation: &StartupCancellation,
            _progress: &dyn StartupScanProgress,
        ) -> PlatformResult<Vec<PlatformStartupSourceResult>> {
            Ok(vec![PlatformStartupSourceResult::unavailable(
                "windows.startup",
                true,
                PlatformStartupCoverageReason::UnsupportedOperatingSystem,
            )])
        }

        fn change_startup_item(
            &self,
            _request: &PlatformStartupChangeRequest,
            _authorization_prompt: Option<&str>,
        ) -> PlatformResult<PlatformStartupChangeResult> {
            Err(PlatformError::new(
                PlatformErrorCode::Unsupported,
                "startup changes are unavailable on this platform",
            ))
        }
    }

    static UNSUPPORTED: Unsupported = Unsupported;
    &UNSUPPORTED
}
