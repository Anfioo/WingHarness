// Systools command service.
//
// Thin, one-to-one wrappers over the `systools-core` Rust commands. The engine
// args are snake_case on the Rust side; Tauri maps the camelCase keys sent here
// onto them.

import { invokeCommand } from "../../base";
import type {
  AnalysisDeleteBatchResult,
  AnalysisExportReceipt,
  AnalysisExportRequest,
  AnalysisRemainderPage,
  AnalysisRemainderRequest,
  AnalysisScanMode,
  AnalysisScanResult,
  ApplicationIcon,
  ApplicationLeftoverPlanItem,
  ApplicationLeftoverResult,
  ApplicationLeftoverScanResult,
  ApplicationUninstallBatchPlan,
  ApplicationUninstallBatchPreparation,
  ApplicationUninstallBatchResult,
  ApplicationUninstallBatchSelection,
  ApplicationUninstallCloseRequest,
  ApplicationUninstallCloseResponse,
  ApplicationUninstallIdentity,
  ApplicationUninstallScanResult,
  DuplicateFilesResult,
  DuplicateGroupPage,
  DuplicateScanLocation,
  FileIconBatch,
  FileIconRequest,
  LargeFileScanMode,
  LargeFilesResult,
  PermanentDeleteBatchResult,
  PermanentDeleteCandidate,
  ScanNameExclusion,
  StartupCatalog,
  StartupChangePlan,
  StartupChangeResult,
  StartupChangeSelection,
  SystemSettingsCatalog,
  SystemSettingsChangePlan,
  SystemSettingsChangeResult,
  SystemSettingsChangeSelection,
  SystoolsPrefs,
  VolumeInfo,
} from "./types";

/** Every startup entry Windows knows about. */
export async function systoolsStartupScan(): Promise<StartupCatalog> {
  return await invokeCommand<Record<string, never>, StartupCatalog>("systools_startup_scan", {});
}

/** Stop an in-flight startup scan. */
export async function systoolsStartupCancelScan(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>("systools_startup_cancel_scan", {});
}

/** Turn a startup selection into a reviewable change plan. */
export async function systoolsStartupPrepareChange(
  selection: StartupChangeSelection
): Promise<StartupChangePlan> {
  return await invokeCommand<{ selection: StartupChangeSelection }, StartupChangePlan>(
    "systools_startup_prepare_change",
    { selection }
  );
}

/** Apply a prepared startup change plan. */
export async function systoolsStartupExecuteChange(
  planId: string,
  authorizationPrompt: string
): Promise<StartupChangeResult> {
  return await invokeCommand<{ planId: string; authorizationPrompt: string }, StartupChangeResult>(
    "systools_startup_execute_change",
    { planId, authorizationPrompt }
  );
}

/** Discard a prepared startup change plan. */
export async function systoolsStartupCancelChange(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>("systools_startup_cancel_change", {});
}

/** Scan the installed applications available for uninstall. */
export async function systoolsUninstallScan(): Promise<ApplicationUninstallScanResult> {
  return await invokeCommand<Record<string, never>, ApplicationUninstallScanResult>(
    "systools_uninstall_scan",
    {}
  );
}

/** Stop an in-flight uninstall scan. */
export async function systoolsUninstallCancelScan(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>("systools_uninstall_cancel_scan", {});
}

/** Describe one application's uninstall identity. */
export async function systoolsUninstallDescribeIdentity(
  applicationId: string,
  catalogRevision: number
): Promise<ApplicationUninstallIdentity> {
  return await invokeCommand<
    { applicationId: string; catalogRevision: number },
    ApplicationUninstallIdentity
  >("systools_uninstall_describe_identity", { applicationId, catalogRevision });
}

/** Ask the listed applications to close before uninstalling. */
export async function systoolsUninstallCloseApplications(
  request: ApplicationUninstallCloseRequest,
  catalogRevision: number
): Promise<ApplicationUninstallCloseResponse> {
  return await invokeCommand<
    { request: ApplicationUninstallCloseRequest; catalogRevision: number },
    ApplicationUninstallCloseResponse
  >("systools_uninstall_close_applications", { request, catalogRevision });
}

/** Turn uninstall selections into a reviewable batch. */
export async function systoolsUninstallPrepareBatch(
  selections: ApplicationUninstallBatchSelection[],
  catalogRevision: number
): Promise<ApplicationUninstallBatchPreparation> {
  return await invokeCommand<
    { selections: ApplicationUninstallBatchSelection[]; catalogRevision: number },
    ApplicationUninstallBatchPreparation
  >("systools_uninstall_prepare_batch", { selections, catalogRevision });
}

/** Execute a prepared uninstall batch, optionally as a dry run. */
export async function systoolsUninstallExecuteBatch(
  plan: ApplicationUninstallBatchPlan,
  dryRun: boolean,
  authorizationPrompt: string
): Promise<ApplicationUninstallBatchResult> {
  return await invokeCommand<
    { plan: ApplicationUninstallBatchPlan; dryRun: boolean; authorizationPrompt: string },
    ApplicationUninstallBatchResult
  >("systools_uninstall_execute_batch", { plan, dryRun, authorizationPrompt });
}

/** Stop an in-flight uninstall batch. */
export async function systoolsUninstallCancelExecution(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>(
    "systools_uninstall_cancel_execution",
    {}
  );
}

/** Remove a stale uninstall record without touching the application. */
export async function systoolsUninstallRemoveRecord(applicationId: string): Promise<void> {
  return await invokeCommand<{ applicationId: string }, void>("systools_uninstall_remove_record", {
    applicationId,
  });
}

/** Open the Windows "Apps & features" settings page. */
export async function systoolsUninstallOpenWindowsApps(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>(
    "systools_uninstall_open_windows_apps",
    {}
  );
}

/** Scan for files and registry keys left behind by uninstalled applications. */
export async function systoolsLeftoversScan(): Promise<ApplicationLeftoverScanResult> {
  return await invokeCommand<Record<string, never>, ApplicationLeftoverScanResult>(
    "systools_leftovers_scan",
    {}
  );
}

/** Delete the reviewed leftovers, optionally as a dry run. */
export async function systoolsLeftoversExecute(
  reviewedItems: ApplicationLeftoverPlanItem[],
  dryRun: boolean,
  operationId: string
): Promise<ApplicationLeftoverResult> {
  return await invokeCommand<
    { reviewedItems: ApplicationLeftoverPlanItem[]; dryRun: boolean; operationId: string },
    ApplicationLeftoverResult
  >("systools_leftovers_execute", { reviewedItems, dryRun, operationId });
}

/** Stop an in-flight leftover deletion. */
export async function systoolsLeftoversCancel(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>("systools_leftovers_cancel", {});
}

/** Application icons for a list of executable paths. */
export async function systoolsApplicationIcons(paths: string[]): Promise<ApplicationIcon[]> {
  return await invokeCommand<{ paths: string[] }, ApplicationIcon[]>("systools_application_icons", {
    paths,
  });
}

/** Scan the Windows system settings this app can optimize. */
export async function systoolsSystemSettingsScan(): Promise<SystemSettingsCatalog> {
  return await invokeCommand<Record<string, never>, SystemSettingsCatalog>(
    "systools_system_settings_scan",
    {}
  );
}

/** Stop an in-flight system settings scan. */
export async function systoolsSystemSettingsCancelScan(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>(
    "systools_system_settings_cancel_scan",
    {}
  );
}

/** Turn a system settings selection into a reviewable change plan. */
export async function systoolsSystemSettingsPrepareChange(
  selection: SystemSettingsChangeSelection
): Promise<SystemSettingsChangePlan> {
  return await invokeCommand<
    { selection: SystemSettingsChangeSelection },
    SystemSettingsChangePlan
  >("systools_system_settings_prepare_change", { selection });
}

/** Apply a prepared system settings change plan. */
export async function systoolsSystemSettingsExecuteChange(
  planId: string
): Promise<SystemSettingsChangeResult> {
  return await invokeCommand<{ planId: string }, SystemSettingsChangeResult>(
    "systools_system_settings_execute_change",
    { planId }
  );
}

/** Scan a directory tree for disk usage. */
export async function systoolsAnalysisScan(
  path: string,
  refresh: boolean,
  excludedPaths: string[],
  excludedNames: ScanNameExclusion[],
  scanMode: AnalysisScanMode
): Promise<AnalysisScanResult> {
  return await invokeCommand<
    {
      path: string;
      refresh: boolean;
      excludedPaths: string[];
      excludedNames: ScanNameExclusion[];
      scanMode: AnalysisScanMode;
    },
    AnalysisScanResult
  >("systools_analysis_scan", { path, refresh, excludedPaths, excludedNames, scanMode });
}

/** Stop an in-flight disk analysis. */
export async function systoolsAnalysisCancel(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>("systools_analysis_cancel", {});
}

/** Read another page of an analysis snapshot's remaining entries. */
export async function systoolsAnalysisRemainderList(
  request: AnalysisRemainderRequest
): Promise<AnalysisRemainderPage> {
  return await invokeCommand<{ request: AnalysisRemainderRequest }, AnalysisRemainderPage>(
    "systools_analysis_remainder_list",
    { request }
  );
}

/** Release an analysis remainder snapshot. */
export async function systoolsAnalysisRemainderRelease(snapshotId: string): Promise<void> {
  return await invokeCommand<{ snapshotId: string }, void>("systools_analysis_remainder_release", {
    snapshotId,
  });
}

/** Export an analysis result through a save dialog. */
export async function systoolsAnalysisExport(
  request: AnalysisExportRequest,
  dialogTitle: string
): Promise<AnalysisExportReceipt> {
  return await invokeCommand<
    { request: AnalysisExportRequest; dialogTitle: string },
    AnalysisExportReceipt
  >("systools_analysis_export", { request, dialogTitle });
}

/** Permanently delete the selected analysis entries. */
export async function systoolsAnalysisDeleteEntries(
  scanId: string,
  selectedPaths: string[]
): Promise<AnalysisDeleteBatchResult> {
  return await invokeCommand<
    { scanId: string; selectedPaths: string[] },
    AnalysisDeleteBatchResult
  >("systools_analysis_delete_entries", { scanId, selectedPaths });
}

/** Scan the given roots for files above a size threshold. */
export async function systoolsLargeFilesScan(
  roots: string[],
  minimumBytes: number,
  scanMode: LargeFileScanMode,
  excludedPaths: string[],
  excludedNames: ScanNameExclusion[]
): Promise<LargeFilesResult> {
  return await invokeCommand<
    {
      roots: string[];
      minimumBytes: number;
      scanMode: LargeFileScanMode;
      excludedPaths: string[];
      excludedNames: ScanNameExclusion[];
    },
    LargeFilesResult
  >("systools_large_files_scan", {
    roots,
    minimumBytes,
    scanMode,
    excludedPaths,
    excludedNames,
  });
}

/** Re-filter a completed large-file scan by a new size threshold. */
export async function systoolsLargeFilesFilter(
  scanId: string,
  minimumBytes: number
): Promise<LargeFilesResult> {
  return await invokeCommand<{ scanId: string; minimumBytes: number }, LargeFilesResult>(
    "systools_large_files_filter",
    { scanId, minimumBytes }
  );
}

/** Stop an in-flight large-file scan. */
export async function systoolsLargeFilesCancel(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>("systools_large_files_cancel", {});
}

/** Permanently delete the selected large files. */
export async function systoolsLargeFilesDelete(
  scanId: string,
  selectedPaths: string[]
): Promise<PermanentDeleteBatchResult> {
  return await invokeCommand<
    { scanId: string; selectedPaths: string[] },
    PermanentDeleteBatchResult
  >("systools_large_files_delete", { scanId, selectedPaths });
}

/** Scan the given locations for duplicate files. */
export async function systoolsDuplicatesScan(
  locations: DuplicateScanLocation[],
  minimumBytes: number,
  excludedPaths: string[],
  excludedNames: ScanNameExclusion[]
): Promise<DuplicateFilesResult> {
  return await invokeCommand<
    {
      locations: DuplicateScanLocation[];
      minimumBytes: number;
      excludedPaths: string[];
      excludedNames: ScanNameExclusion[];
    },
    DuplicateFilesResult
  >("systools_duplicates_scan", { locations, minimumBytes, excludedPaths, excludedNames });
}

/** Stop an in-flight duplicate scan. */
export async function systoolsDuplicatesCancel(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>("systools_duplicates_cancel", {});
}

/** Read one page of duplicate groups. */
export async function systoolsDuplicatesPage(
  scanId: string,
  offset: number,
  limit: number
): Promise<DuplicateGroupPage> {
  return await invokeCommand<{ scanId: string; offset: number; limit: number }, DuplicateGroupPage>(
    "systools_duplicates_page",
    { scanId, offset, limit }
  );
}

/** Permanently delete the selected duplicate candidates. */
export async function systoolsDuplicatesDelete(
  scanId: string,
  candidates: PermanentDeleteCandidate[]
): Promise<PermanentDeleteBatchResult> {
  return await invokeCommand<
    { scanId: string; candidates: PermanentDeleteCandidate[] },
    PermanentDeleteBatchResult
  >("systools_duplicates_delete", { scanId, candidates });
}

/** List the mounted volumes, optionally rescanning them. */
export async function systoolsVolumesList(refresh: boolean): Promise<VolumeInfo[]> {
  return await invokeCommand<{ refresh: boolean }, VolumeInfo[]>("systools_volumes_list", {
    refresh,
  });
}

/** Describe the volume the system drive is on. */
export async function systoolsSystemDisk(): Promise<VolumeInfo> {
  return await invokeCommand<Record<string, never>, VolumeInfo>("systools_system_disk", {});
}

/** Keep only the paths that are real directories. */
export async function systoolsFilterDirectoryPaths(paths: string[]): Promise<string[]> {
  return await invokeCommand<{ paths: string[] }, string[]>("systools_filter_directory_paths", {
    paths,
  });
}

/** Reveal a path in Windows File Explorer. */
export async function systoolsRevealInFileManager(path: string): Promise<void> {
  return await invokeCommand<{ path: string }, void>("systools_reveal_in_file_manager", { path });
}

/** Open one analysis entry in its parent folder. */
export async function systoolsOpenAnalysisEntry(
  scanId: string,
  selectedPath: string
): Promise<void> {
  return await invokeCommand<{ scanId: string; selectedPath: string }, void>(
    "systools_open_analysis_entry",
    { scanId, selectedPath }
  );
}

/** Open one large-file entry in its parent folder. */
export async function systoolsOpenLargeFileEntry(
  scanId: string,
  selectedPath: string
): Promise<void> {
  return await invokeCommand<{ scanId: string; selectedPath: string }, void>(
    "systools_open_large_file_entry",
    { scanId, selectedPath }
  );
}

/** Open one duplicate entry in its parent folder. */
export async function systoolsOpenDuplicateEntry(
  scanId: string,
  selectedPath: string
): Promise<void> {
  return await invokeCommand<{ scanId: string; selectedPath: string }, void>(
    "systools_open_duplicate_entry",
    { scanId, selectedPath }
  );
}

/** Resolve shell icons for a batch of files. */
export async function systoolsFileIcons(requests: FileIconRequest[]): Promise<FileIconBatch> {
  return await invokeCommand<{ requests: FileIconRequest[] }, FileIconBatch>(
    "systools_file_icons",
    { requests }
  );
}

/** Read the persisted systools preferences. */
export async function systoolsPrefsGet(): Promise<SystoolsPrefs> {
  return await invokeCommand<Record<string, never>, SystoolsPrefs>("systools_prefs_get", {});
}

/** Persist the systools preferences. */
export async function systoolsPrefsSet(prefs: SystoolsPrefs): Promise<void> {
  return await invokeCommand<{ prefs: SystoolsPrefs }, void>("systools_prefs_set", { prefs });
}
