// Systools DTOs.
//
// These mirror the Rust DTOs with camelCase field names. The large catalog and
// result types are placeholders: each feature lane replaces the ones it owns
// with their final shape, without touching the command wrappers. Until then
// they stay permissive so an opaque payload still type-checks.

export type SystoolsErrorCode =
  | "invalidInput"
  | "operationBusy"
  | "operationCancelled"
  | "operationFailed"
  | "permissionDenied"
  | "persistenceFailed"
  | "taskJoinFailed"
  | "notImplemented";

export interface SystoolsError {
  code: SystoolsErrorCode;
  details: Record<string, string>;
  retryable: boolean;
}

/** A file or folder name that every scan should skip. */
export interface ScanNameExclusion {
  name: string;
  kind: "file" | "folder";
}

/** Persisted user preferences, shared by all six tools. */
export interface SystoolsPrefs {
  excludedPaths: string[];
  excludedNames: ScanNameExclusion[];
}

export type AnalysisScanMode = "standard" | "fast";
export type LargeFileScanMode = "quick" | "complete";

export type VolumeInfo = Record<string, unknown>;
export type DirectorySelectionOutcome = Record<string, unknown>;
export type PermanentDeleteCandidate = Record<string, unknown>;
export type PermanentDeleteBatchResult = Record<string, unknown>;

export type StartupCatalog = Record<string, unknown>;
export type StartupChangeSelection = Record<string, unknown>;
export type StartupChangePlan = Record<string, unknown>;
export type StartupChangeResult = Record<string, unknown>;

export type ApplicationUninstallScanResult = Record<string, unknown>;
export type ApplicationUninstallIdentity = Record<string, unknown>;
export type ApplicationUninstallCloseRequest = Record<string, unknown>;
export type ApplicationUninstallCloseResponse = Record<string, unknown>;
export type ApplicationUninstallBatchSelection = Record<string, unknown>;
export type ApplicationUninstallBatchPreparation = Record<string, unknown>;
export type ApplicationUninstallBatchPlan = Record<string, unknown>;
export type ApplicationUninstallBatchResult = Record<string, unknown>;

export type ApplicationLeftoverScanResult = Record<string, unknown>;
export type ApplicationLeftoverPlanItem = Record<string, unknown>;
export type ApplicationLeftoverResult = Record<string, unknown>;

export type ApplicationIcon = Record<string, unknown>;

export type SystemSettingsCatalog = Record<string, unknown>;
export type SystemSettingsChangeSelection = Record<string, unknown>;
export type SystemSettingsChangePlan = Record<string, unknown>;
export type SystemSettingsChangeResult = Record<string, unknown>;

export type AnalysisScanResult = Record<string, unknown>;
export type AnalysisRemainderRequest = Record<string, unknown>;
export type AnalysisRemainderPage = Record<string, unknown>;
export type AnalysisDeleteBatchResult = Record<string, unknown>;
export type AnalysisExportRequest = Record<string, unknown>;
export type AnalysisExportReceipt = Record<string, unknown>;

export type LargeFilesResult = Record<string, unknown>;

export type DuplicateFilesResult = Record<string, unknown>;
export type DuplicateScanLocation = Record<string, unknown>;
export type DuplicateGroupPage = Record<string, unknown>;

export type FileIconRequest = Record<string, unknown>;
export type FileIconBatch = Record<string, unknown>;
