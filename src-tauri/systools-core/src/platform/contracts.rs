//! Stable platform contracts shared by native adapters and the product layer.
//!
//! This module is deliberately self-contained: it only depends on the standard
//! library and serde, so both the domain models and the elevated helpers can
//! import the same shapes without creating a dependency cycle.

use std::{error::Error, fmt};

// ---------------------------------------------------------------------------
// Platform errors
// ---------------------------------------------------------------------------

/// Stable error categories exposed by platform contracts.
///
/// Diagnostics remain native and English for logs. Product adapters localize
/// the code instead of interpreting diagnostic text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformErrorCode {
    AccessDenied,
    UserCancelled,
    ItemChanged,
    InvalidData,
    InvalidPath,
    Io,
    OperationFailed,
    Unsupported,
}

/// Optional, stable context for failures that a broad platform error code cannot explain.
/// Callers may localize this reason without interpreting native messages or exit-code text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformFailureReason {
    ToolUnavailable,
    ServiceDisabled,
    ServiceUnavailable,
    DependencyUnavailable,
    ServiceBusy,
    TimedOut,
    VerificationFailed,
    VerificationPermissionDenied,
}

/// Describes whether a failed native operation can still have changed operating-system state.
///
/// Callers use this signal to retain preflight recovery data when a write or its verification
/// fails. Treating every error as side-effect free would make a successfully written setting
/// irreversible when only the post-write read failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformMutationState {
    NotAttempted,
    MayHaveChanged,
}

impl PlatformError {
    pub fn item_changed(diagnostic: impl Into<String>) -> Self {
        Self::new(PlatformErrorCode::ItemChanged, diagnostic)
    }
}

#[derive(Debug, Clone)]
pub struct PlatformError {
    code: PlatformErrorCode,
    diagnostic: Box<str>,
    mutation_state: PlatformMutationState,
    failure_reason: Option<PlatformFailureReason>,
    io_kind: Option<std::io::ErrorKind>,
    native_code: Option<i32>,
}

impl PlatformError {
    pub fn new(code: PlatformErrorCode, diagnostic: impl Into<String>) -> Self {
        Self {
            code,
            diagnostic: diagnostic.into().into_boxed_str(),
            mutation_state: PlatformMutationState::NotAttempted,
            failure_reason: None,
            io_kind: None,
            native_code: None,
        }
    }

    pub fn with_failure_reason(mut self, reason: PlatformFailureReason) -> Self {
        self.failure_reason = Some(reason);
        self
    }

    pub fn failure_reason(&self) -> Option<PlatformFailureReason> {
        self.failure_reason
    }

    pub fn code(&self) -> PlatformErrorCode {
        self.code
    }

    pub fn io_kind(&self) -> Option<std::io::ErrorKind> {
        self.io_kind
    }

    pub fn native_code(&self) -> Option<i32> {
        self.native_code
    }

    pub fn diagnostic(&self) -> &str {
        &self.diagnostic
    }

    pub fn mutation_state(&self) -> PlatformMutationState {
        self.mutation_state
    }

    /// Marks an error returned after a native write was attempted. The original diagnostic and
    /// stable code stay unchanged so existing product error mapping remains compatible.
    pub fn with_possible_side_effects(mut self) -> Self {
        self.mutation_state = PlatformMutationState::MayHaveChanged;
        self
    }

    /// Returns the stable diagnostic payload for hashing or structured logs.
    pub fn as_bytes(&self) -> &[u8] {
        self.diagnostic.as_bytes()
    }

    pub fn operation_failed(diagnostic: impl Into<String>) -> Self {
        Self::new(PlatformErrorCode::OperationFailed, diagnostic)
    }

    pub fn invalid_path(diagnostic: impl Into<String>) -> Self {
        Self::new(PlatformErrorCode::InvalidPath, diagnostic)
    }

    pub fn io(operation: &'static str, error: &std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::PermissionDenied => PlatformErrorCode::AccessDenied,
            std::io::ErrorKind::InvalidData | std::io::ErrorKind::InvalidInput => {
                PlatformErrorCode::InvalidData
            }
            _ => PlatformErrorCode::Io,
        };
        let mut failure = Self::new(
            code,
            format!(
                "{operation}: kind={:?} os_code={:?} error={error}",
                error.kind(),
                error.raw_os_error()
            ),
        );
        failure.io_kind = Some(error.kind());
        failure.native_code = error.raw_os_error();
        failure
    }
}

impl fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.diagnostic)
    }
}

impl Error for PlatformError {}

impl From<String> for PlatformError {
    fn from(diagnostic: String) -> Self {
        Self::operation_failed(diagnostic)
    }
}

impl From<&str> for PlatformError {
    fn from(diagnostic: &str) -> Self {
        Self::operation_failed(diagnostic)
    }
}

pub type PlatformResult<T> = Result<T, PlatformError>;

// ---------------------------------------------------------------------------
// Application dates
// ---------------------------------------------------------------------------

/// Evidence source for one application date.
///
/// Only sources a Windows adapter can produce are retained. The wire codes stay
/// stable across releases so cached inventory entries remain readable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationDateSource {
    ApplicationDataModified,
    CacheModified,
    DirectoryModified,
    PackageReceipt,
    DirectoryAdded,
    PlatformReported,
}

impl ApplicationDateSource {
    pub fn is_estimated(self) -> bool {
        matches!(
            self,
            Self::ApplicationDataModified
                | Self::CacheModified
                | Self::DirectoryModified
                | Self::DirectoryAdded
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationDatePrecision {
    Timestamp,
    /// A calendar date encoded in UTC; adapters must not shift it across time zones.
    Day,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationDateReadStatus {
    #[default]
    Unavailable,
    Complete,
    Partial,
}

/// Evidence is presentation-only and must never authorize uninstall or infer disuse.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDate {
    pub timestamp_ms: u64,
    pub source: ApplicationDateSource,
    pub precision: ApplicationDatePrecision,
    pub captured_at_ms: u64,
    pub estimated: bool,
    /// A bound or unreadable subtree can hide a newer observation.
    pub partial: bool,
}

impl ApplicationDate {
    pub fn new(
        timestamp_ms: u64,
        source: ApplicationDateSource,
        captured_at_ms: u64,
    ) -> Option<Self> {
        (timestamp_ms > 0 && timestamp_ms <= captured_at_ms).then_some(Self {
            timestamp_ms,
            source,
            precision: ApplicationDatePrecision::Timestamp,
            captured_at_ms,
            estimated: source.is_estimated(),
            partial: false,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDates {
    pub last_used: Option<ApplicationDate>,
    pub installed: Option<ApplicationDate>,
    pub read_status: ApplicationDateReadStatus,
}

// ---------------------------------------------------------------------------
// Application identity metadata
// ---------------------------------------------------------------------------

/// Descriptive evidence only; metadata and certificate names do not establish product safety.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "platform",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ApplicationIdentityMetadata {
    Windows {
        #[serde(skip_serializing_if = "Option::is_none")]
        product_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        file_description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        company_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        package_identity: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Application uninstall diagnostics
// ---------------------------------------------------------------------------

/// Explains why no executable uninstall registration was accepted.
///
/// Raw command text never leaves the platform layer; this typed reason is safe to
/// log next to the redacted application ID and to show in the catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallDiagnostic {
    CommandMissing,
    CommandUnreadable,
    InvalidCommand,
    RelativeExecutable,
    UnresolvedEnvironment,
    ExecutableMissing,
    ExecutableAccessDenied,
    ExecutableProbeFailed,
    InvalidExecutable,
    UnsupportedCommandHost,
    RegistrationConflict,
}

impl ApplicationUninstallDiagnostic {
    pub const fn stable_code(self) -> &'static str {
        match self {
            Self::CommandMissing => "command_missing",
            Self::CommandUnreadable => "command_unreadable",
            Self::InvalidCommand => "invalid_command",
            Self::RelativeExecutable => "relative_executable",
            Self::UnresolvedEnvironment => "unresolved_environment",
            Self::ExecutableMissing => "executable_missing",
            Self::ExecutableAccessDenied => "executable_access_denied",
            Self::ExecutableProbeFailed => "executable_probe_failed",
            Self::InvalidExecutable => "invalid_executable",
            Self::UnsupportedCommandHost => "unsupported_command_host",
            Self::RegistrationConflict => "registration_conflict",
        }
    }
}

// ---------------------------------------------------------------------------
// System settings diagnostics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformSystemSettingDiagnosticCode {
    AccessDenied,
    InvalidData,
    Unsupported,
    StateUnavailable,
}

// ---------------------------------------------------------------------------
// Filesystem and scan kernel contracts
// ---------------------------------------------------------------------------

pub(crate) mod diagnostics;
mod directory_aggregate;
mod file_read;
mod name_exclusions;
mod platform;
mod scan;
mod volumes;

pub use directory_aggregate::{
    DirectPhysicalDirectoryEnumeration, DirectoryTreeAggregate, DirectoryTreeAggregateError,
    DirectoryTreeSourceAggregate,
};
#[cfg(not(target_os = "linux"))]
pub(crate) use directory_aggregate::DirectoryAggregateProgress;
pub use file_read::{
    FileReadFailureDetail, FileReadFailureReason, FileReadFailures, FileReadStage,
    MAX_FILE_READ_FAILURE_DETAILS,
};
pub use name_exclusions::{ExcludedNameKind, NameExclusions, ScanNameExclusion};
pub use platform::{current_platform, Platform, PlatformCancellation};
pub use scan::{
    DirectoryEntryIdentities, FastAnalysisFile, FastAnalysisQuery, FastAnalysisRecord,
    FastAnalysisScanError, FastAnalysisSummary, FileSpaceUsage, FilesystemChangeImpactError,
    FilesystemChangeImpactOutcome, FilesystemChangeImpactPlan, FilesystemChangeImpactSummary,
    FilesystemChangeImpactUnavailable, FilesystemChangeMonitor, FilesystemChangeStatus,
    FilesystemChangeToken, LargeFileCandidateScanError, LargeFileCandidateSummary,
    PhysicalFileIdentity, ScanOmissionCounts, ScanPurpose, SkipReason,
};
// The Windows monitor implementation is the only `FilesystemChangeMonitor` constructor.
pub(crate) use scan::FilesystemChangeMonitorBackend;
pub use volumes::{
    ApplicationDirectories, ScanConcurrency, ScanDeviceClass, UserDirectories, VolumeInfo,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_io_diagnostic_retains_os_code_and_reason() {
        let native = std::io::Error::from_raw_os_error(2);
        let error = PlatformError::io("read_fixture", &native);
        assert_eq!(error.code(), PlatformErrorCode::Io);
        assert_eq!(error.io_kind(), Some(std::io::ErrorKind::NotFound));
        assert_eq!(error.native_code(), Some(2));
        assert!(error.diagnostic().contains("os_code=Some(2)"));
        assert!(error.diagnostic().contains(&native.to_string()));
    }

    #[test]
    fn possible_side_effects_preserve_the_original_error_code() {
        let error = PlatformError::new(PlatformErrorCode::AccessDenied, "test")
            .with_possible_side_effects();

        assert_eq!(error.code(), PlatformErrorCode::AccessDenied);
        assert_eq!(
            error.mutation_state(),
            PlatformMutationState::MayHaveChanged
        );
    }

    #[test]
    fn evidence_rejects_empty_and_future_dates() {
        assert!(ApplicationDate::new(0, ApplicationDateSource::DirectoryModified, 10).is_none());
        assert!(ApplicationDate::new(11, ApplicationDateSource::DirectoryModified, 10).is_none());
        assert!(ApplicationDate::new(10, ApplicationDateSource::DirectoryModified, 10).is_some());
    }

    #[test]
    fn source_and_precision_have_stable_wire_codes() {
        let mut date = ApplicationDate::new(10, ApplicationDateSource::PackageReceipt, 20).unwrap();
        date.precision = ApplicationDatePrecision::Day;
        let wire = serde_json::to_value(date).unwrap();
        assert_eq!(wire["source"], "packageReceipt");
        assert_eq!(wire["precision"], "day");
        assert_eq!(wire["timestampMs"], 10);
        assert!(ApplicationDateSource::DirectoryModified.is_estimated());
        assert!(!ApplicationDateSource::PlatformReported.is_estimated());
    }
}
