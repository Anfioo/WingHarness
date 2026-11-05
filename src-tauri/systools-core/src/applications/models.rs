use serde::{Deserialize, Serialize};

use crate::platform::contracts::{
    ApplicationDates, ApplicationIdentityMetadata, ApplicationUninstallDiagnostic,
};

pub const APPLICATION_UNINSTALL_SCAN_SCHEMA_VERSION: u32 = 12;
pub const APPLICATION_UNINSTALL_IDENTITY_SCHEMA_VERSION: u32 = 1;
pub const APPLICATION_UNINSTALL_INSPECTION_SCHEMA_VERSION: u32 = 3;
pub const APPLICATION_UNINSTALL_PLAN_SCHEMA_VERSION: u32 = 2;
pub const APPLICATION_UNINSTALL_BATCH_PLAN_SCHEMA_VERSION: u32 = 1;
pub const APPLICATION_LEFTOVER_SCAN_SCHEMA_VERSION: u32 = 2;
pub const APPLICATION_LEFTOVER_PLAN_SCHEMA_VERSION: u32 = 1;

/// Classifies presentation evidence without changing uninstall or record-removal capabilities.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationSystemKind {
    /// No positive evidence. This does not claim that the application is safe to remove.
    #[default]
    Unclassified,
    WindowsSystemPackage,
    WindowsBuiltinApp,
    WindowsSharedPackage,
    SharedRuntime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallIdentity {
    pub schema_version: u32,
    pub metadata: Option<ApplicationIdentityMetadata>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallPlatform {
    WindowsRegistry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallInstallerKind {
    WindowsMsi,
    WindowsAppx,
    WindowsScoop,
    WindowsChocolatey,
    WindowsRegistered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallInventorySource {
    WindowsRegistry,
    WindowsMsi,
    WindowsAppx,
    Winget,
    Steam,
    Scoop,
    Chocolatey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallExecutionMode {
    Silent,
    Interactive,
    ExternalClient,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallSourceIdentity {
    pub source: ApplicationUninstallInventorySource,
    pub identifier: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallCapability {
    Ready,
    ApplicationRunning,
    RequiresElevation,
    ProtectedApplication,
    ViewOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallRecordState {
    Installed,
    OrphanedRegistration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallCandidate {
    pub application_id: String,
    pub primary_identifier: String,
    pub source_identities: Vec<ApplicationUninstallSourceIdentity>,
    /// Presentation classification only. Explicit uninstall and record removal remain independent.
    pub system_kind: ApplicationSystemKind,
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    /// Platform catalog estimate. Windows registrations normally expose logical sizes and cannot
    /// account exactly for compression, clones, or shared package data.
    pub estimated_bytes: u64,
    pub dates: ApplicationDates,
    pub platform: ApplicationUninstallPlatform,
    pub installer_kind: Option<ApplicationUninstallInstallerKind>,
    pub execution_mode: Option<ApplicationUninstallExecutionMode>,
    pub capability: ApplicationUninstallCapability,
    pub record_state: ApplicationUninstallRecordState,
    pub uninstall_diagnostic: Option<ApplicationUninstallDiagnostic>,
    pub application_path: Option<String>,
    /// Existing user-data locations whose names match multiple stable catalog
    /// facts. These paths are read-only hints, not verified uninstall
    /// components, and never contribute to selection or byte totals.
    pub possible_related_paths: Vec<String>,
    pub icon_path: Option<String>,
    pub running_processes: Vec<String>,
    /// Sum of component estimates used for catalog comparison, never an exact free-space promise.
    pub total_bytes: u64,
    /// Estimated bytes represented by components selected by default.
    pub default_selected_bytes: u64,
    pub associated_data_complete: bool,
    pub components: Vec<ApplicationUninstallComponentSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallComponentSummary {
    pub component_id: String,
    pub kind: ApplicationUninstallComponentKind,
    pub risk: ApplicationUninstallRisk,
    pub path: Option<String>,
    pub bytes: u64,
    pub file_count: u64,
    pub default_selected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallScanResult {
    pub schema_version: u32,
    pub scanned_at_ms: u64,
    pub supported: bool,
    pub execution_supported: bool,
    /// Whether the captured catalog is stable enough to inspect and remove
    /// verified applications.
    pub catalog_actionable: bool,
    pub inventory_complete: bool,
    pub catalog_revision: Option<String>,
    pub candidates: Vec<ApplicationUninstallCandidate>,
    pub ready_count: u64,
    pub blocked_count: u64,
    pub hidden_count: u64,
    pub related_directory_count: u64,
    pub related_path_scan_elapsed_ms: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallComponentKind {
    ApplicationBinary,
    NativeInstaller,
    Cache,
    ApplicationSupport,
    Preferences,
    Logs,
    SavedState,
    SandboxContainer,
    WebData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallRisk {
    Required,
    Rebuildable,
    UserData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallComponent {
    pub component_id: String,
    pub kind: ApplicationUninstallComponentKind,
    pub risk: ApplicationUninstallRisk,
    pub path: Option<String>,
    pub bytes: u64,
    pub file_count: u64,
    pub default_selected: bool,
    pub snapshot_fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallInspection {
    pub schema_version: u32,
    pub inspected_at_ms: u64,
    pub application_id: String,
    pub application_name: String,
    pub primary_identifier: String,
    pub platform: ApplicationUninstallPlatform,
    pub installer_kind: Option<ApplicationUninstallInstallerKind>,
    pub capability: ApplicationUninstallCapability,
    pub catalog_revision: String,
    pub components: Vec<ApplicationUninstallComponent>,
    pub total_bytes: u64,
    pub default_selected_bytes: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationUninstallPlanItem {
    pub component_id: String,
    pub kind: ApplicationUninstallComponentKind,
    pub expected_bytes: u64,
    pub expected_file_count: u64,
    pub expected_snapshot_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationUninstallPlan {
    pub schema_version: u32,
    pub plan_id: String,
    pub plan_hash: String,
    pub created_at_ms: u64,
    pub application_id: String,
    pub catalog_revision: String,
    pub items: Vec<ApplicationUninstallPlanItem>,
    pub expected_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationUninstallBatchSelection {
    pub application_id: String,
    pub component_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationCloseMode {
    Graceful,
    Force,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationCloseTargetStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCloseTargetResult {
    pub target_id: String,
    pub status: ApplicationCloseTargetStatus,
    pub matched_process_count: u64,
    pub requested_process_count: u64,
    pub remaining_processes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCloseBatchResult {
    pub mode: ApplicationCloseMode,
    pub matched_process_count: u64,
    pub requested_process_count: u64,
    pub remaining_process_count: u64,
    pub failed_target_count: u64,
    pub targets: Vec<ApplicationCloseTargetResult>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationUninstallCloseRequest {
    pub application_ids: Vec<String>,
    pub mode: ApplicationCloseMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallCloseResponse {
    pub close_result: ApplicationCloseBatchResult,
    pub catalog: ApplicationUninstallScanResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationUninstallBatchPlan {
    pub schema_version: u32,
    pub batch_id: String,
    pub batch_hash: String,
    pub created_at_ms: u64,
    pub catalog_revision: String,
    pub plans: Vec<ApplicationUninstallPlan>,
    pub expected_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallBatchPreparation {
    pub plan: ApplicationUninstallBatchPlan,
    pub preview: ApplicationUninstallBatchResult,
}

/// Stable execution stages for a prepared uninstall batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallExecutionStage {
    Validating,
    Uninstalling,
    Finalizing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallExecutionItemStatus {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallExecutionItemResult {
    pub application_id: String,
    pub status: ApplicationUninstallExecutionItemStatus,
    pub released_bytes: u64,
}

/// A low-frequency batch snapshot emitted only at application boundaries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallExecutionProgress {
    pub stage: ApplicationUninstallExecutionStage,
    pub current_application_id: Option<String>,
    pub completed_applications: Vec<ApplicationUninstallExecutionItemResult>,
    pub completed_application_count: u64,
    pub total_application_count: u64,
    pub affected_application_count: u64,
    pub failed_application_count: u64,
    pub released_bytes: u64,
    pub elapsed_ms: u64,
}

/// Stages of one application-inventory scan, in the order they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationScanStage {
    DiscoveringApplications,
    CheckingProcesses,
    ValidatingApplications,
}

/// One low-frequency snapshot of the running application scan.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationScanProgress {
    pub stage: ApplicationScanStage,
    /// Bounded 0-100 estimate; the inventory stage carries most of the weight.
    pub percent: u8,
    pub items_scanned: u64,
    pub items_total: Option<u64>,
    pub current_path: Option<String>,
    pub elapsed_ms: u64,
}

/// Stages of one leftover scan, in the order they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationLeftoverScanStage {
    UninstallRegistry,
    OrphanRegistryGroups,
    DataDirectories,
    Shortcuts,
}

/// One low-frequency snapshot of the running leftover scan.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationLeftoverScanProgress {
    pub stage: ApplicationLeftoverScanStage,
    pub percent: u8,
    pub items_scanned: u64,
    pub items_total: Option<u64>,
    pub current_path: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallActionStatus {
    Previewed,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationUninstallActionReason {
    ApplicationUnavailable,
    ApplicationRunning,
    ProcessStateUnavailable,
    CatalogChanged,
    ComponentUnavailable,
    ComponentChanged,
    UnsupportedExecutor,
    ExecutionAborted,
    ExternalUninstallerContinuing,
    #[serde(alias = "moveToTrashFailed")]
    PermanentDeleteFailed,
    RecoveryRequired,
    NativeInstallerFailed,
    RemovalUnconfirmed,
    NativeInstallerFailedAfterRemoval,
    VerificationFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallActionResult {
    pub component_id: String,
    pub kind: ApplicationUninstallComponentKind,
    pub status: ApplicationUninstallActionStatus,
    pub reason: Option<ApplicationUninstallActionReason>,
    pub expected_bytes: u64,
    pub released_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallResult {
    pub plan_id: String,
    pub application_id: String,
    pub application_name: Option<String>,
    pub expected_bytes: u64,
    pub previewed_bytes: u64,
    pub released_bytes: u64,
    pub previewed_item_count: u64,
    pub affected_item_count: u64,
    pub failed_item_count: u64,
    pub released_bytes_is_estimate: bool,
    pub restart_required: bool,
    pub dry_run: bool,
    pub actions: Vec<ApplicationUninstallActionResult>,
    pub history_saved: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallBatchResult {
    pub batch_id: String,
    pub expected_bytes: u64,
    pub previewed_bytes: u64,
    pub released_bytes: u64,
    pub selected_application_count: u64,
    pub previewed_application_count: u64,
    pub affected_application_count: u64,
    pub failed_application_count: u64,
    pub previewed_item_count: u64,
    pub affected_item_count: u64,
    pub failed_item_count: u64,
    pub released_bytes_is_estimate: bool,
    pub restart_required: bool,
    pub dry_run: bool,
    pub results: Vec<ApplicationUninstallResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationLeftoverSource {
    SandboxContainer,
    ApplicationSupport,
    Preferences,
    Logs,
    SavedState,
    WebData,
    ApplicationScripts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationLeftoverConfidence {
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationLeftoverEvidence {
    ContainerMetadataVerified,
    FormerBundleMissing,
    InstalledOwnerAbsent,
    ExactIdentifierAssociation,
    FilesystemSnapshotComplete,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationLeftoverCandidate {
    pub candidate_id: String,
    pub application_identifier: String,
    pub application_name: String,
    pub source: ApplicationLeftoverSource,
    pub path: String,
    pub bytes: u64,
    pub file_count: u64,
    pub modified_at_ms: Option<u64>,
    pub confidence: ApplicationLeftoverConfidence,
    pub default_selected: bool,
    pub evidence: Vec<ApplicationLeftoverEvidence>,
    /// The complete metadata snapshot is returned so a reviewed GUI result can
    /// explain why a later execution rejects an item after it changes.
    pub snapshot_fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationLeftoverScanResult {
    pub schema_version: u32,
    pub scanned_at_ms: u64,
    pub supported: bool,
    pub inventory_complete: bool,
    pub access_limited: bool,
    pub candidates: Vec<ApplicationLeftoverCandidate>,
    pub total_bytes: u64,
    pub total_file_count: u64,
    pub skipped_count: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationLeftoverPlanItem {
    pub candidate_id: String,
    pub expected_bytes: u64,
    pub expected_file_count: u64,
    pub expected_snapshot_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationLeftoverPlan {
    pub schema_version: u32,
    pub plan_id: String,
    pub plan_hash: String,
    pub created_at_ms: u64,
    pub items: Vec<ApplicationLeftoverPlanItem>,
    pub expected_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationLeftoverActionStatus {
    Previewed,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationLeftoverActionReason {
    CandidateChanged,
    OwnerReappeared,
    ApplicationRunning,
    #[serde(alias = "moveToTrashFailed")]
    PermanentDeleteFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationLeftoverActionResult {
    pub candidate_id: String,
    pub application_identifier: String,
    pub application_name: String,
    pub status: ApplicationLeftoverActionStatus,
    pub reason: Option<ApplicationLeftoverActionReason>,
    pub expected_bytes: u64,
    pub released_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationLeftoverResult {
    pub plan_id: String,
    pub expected_bytes: u64,
    pub released_bytes: u64,
    pub affected_item_count: u64,
    pub failed_item_count: u64,
    pub dry_run: bool,
    pub actions: Vec<ApplicationLeftoverActionResult>,
    pub history_saved: bool,
}

/// One encoded application icon delivered to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationIcon {
    pub path: String,
    pub data_url: String,
}
