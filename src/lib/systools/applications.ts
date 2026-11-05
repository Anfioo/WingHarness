// Typed application-uninstall layer for the systools UI.
//
// The shapes mirror `systools-core/src/applications/models.rs` (serde camelCase).
// Command wrappers live here instead of `src/commands/services/systools` because
// that service still exposes permissive placeholder payloads and types
// `catalogRevision` as a number, while the native side expects a string.

import { invokeCommand } from "@/commands/base";
import type { SystoolsError } from "@/commands/services/systools/types";

export const UNINSTALL_PROGRESS_EVENT = "systools:uninstall-progress";
export const UNINSTALL_EXECUTION_PROGRESS_EVENT = "systools:uninstall-execution-progress";
export const LEFTOVERS_PROGRESS_EVENT = "systools:leftovers-progress";

/** Stages of the running application-inventory scan, in execution order. */
export type ApplicationScanStage =
  | "discoveringApplications"
  | "checkingProcesses"
  | "validatingApplications";

export interface ApplicationScanProgress {
  stage: ApplicationScanStage;
  percent: number;
  itemsScanned: number;
  itemsTotal: number | null;
  currentPath: string | null;
  elapsedMs: number;
}

/** Stages of the running leftover scan, in execution order. */
export type ApplicationLeftoverScanStage =
  | "uninstallRegistry"
  | "orphanRegistryGroups"
  | "dataDirectories"
  | "shortcuts";

export interface ApplicationLeftoverScanProgress {
  stage: ApplicationLeftoverScanStage;
  percent: number;
  itemsScanned: number;
  itemsTotal: number | null;
  currentPath: string | null;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Shared platform contracts (application dates and identity evidence)
// ---------------------------------------------------------------------------

export type ApplicationDateSource =
  | "applicationDataModified"
  | "cacheModified"
  | "directoryModified"
  | "packageReceipt"
  | "directoryAdded"
  | "platformReported";

export type ApplicationDatePrecision = "timestamp" | "day";
export type ApplicationDateReadStatus = "unavailable" | "complete" | "partial";

export interface ApplicationDate {
  timestampMs: number;
  source: ApplicationDateSource;
  precision: ApplicationDatePrecision;
  capturedAtMs: number;
  estimated: boolean;
  partial: boolean;
}

export interface ApplicationDates {
  lastUsed: ApplicationDate | null;
  installed: ApplicationDate | null;
  readStatus: ApplicationDateReadStatus;
}

export interface ApplicationIdentityMetadata {
  platform: "windows";
  productName?: string;
  fileDescription?: string;
  companyName?: string;
  packageIdentity?: string;
}

export interface ApplicationUninstallIdentity {
  schemaVersion: number;
  metadata: ApplicationIdentityMetadata | null;
}

export type ApplicationUninstallDiagnostic =
  | "commandMissing"
  | "commandUnreadable"
  | "invalidCommand"
  | "relativeExecutable"
  | "unresolvedEnvironment"
  | "executableMissing"
  | "executableAccessDenied"
  | "executableProbeFailed"
  | "invalidExecutable"
  | "unsupportedCommandHost"
  | "registrationConflict";

// ---------------------------------------------------------------------------
// Catalog shapes
// ---------------------------------------------------------------------------

export type ApplicationSystemKind =
  | "unclassified"
  | "windowsSystemPackage"
  | "windowsBuiltinApp"
  | "windowsSharedPackage"
  | "sharedRuntime";

export type ApplicationUninstallPlatform = "windowsRegistry";

export type ApplicationUninstallInstallerKind =
  | "windowsMsi"
  | "windowsAppx"
  | "windowsScoop"
  | "windowsChocolatey"
  | "windowsRegistered";

export type ApplicationUninstallInventorySource =
  | "windowsRegistry"
  | "windowsMsi"
  | "windowsAppx"
  | "winget"
  | "steam"
  | "scoop"
  | "chocolatey";

export type ApplicationUninstallExecutionMode = "silent" | "interactive" | "externalClient";

export interface ApplicationUninstallSourceIdentity {
  source: ApplicationUninstallInventorySource;
  identifier: string;
}

export type ApplicationUninstallCapability =
  | "ready"
  | "applicationRunning"
  | "requiresElevation"
  | "protectedApplication"
  | "viewOnly";

export type ApplicationUninstallRecordState = "installed" | "orphanedRegistration";

export type ApplicationUninstallComponentKind =
  | "applicationBinary"
  | "nativeInstaller"
  | "cache"
  | "applicationSupport"
  | "preferences"
  | "logs"
  | "savedState"
  | "sandboxContainer"
  | "webData";

export type ApplicationUninstallRisk = "required" | "rebuildable" | "userData";

export interface ApplicationUninstallComponentSummary {
  componentId: string;
  kind: ApplicationUninstallComponentKind;
  risk: ApplicationUninstallRisk;
  path: string | null;
  bytes: number;
  fileCount: number;
  defaultSelected: boolean;
}

export interface ApplicationUninstallCandidate {
  applicationId: string;
  primaryIdentifier: string;
  sourceIdentities: ApplicationUninstallSourceIdentity[];
  systemKind: ApplicationSystemKind;
  name: string;
  version: string | null;
  publisher: string | null;
  estimatedBytes: number;
  dates: ApplicationDates;
  platform: ApplicationUninstallPlatform;
  installerKind: ApplicationUninstallInstallerKind | null;
  executionMode: ApplicationUninstallExecutionMode | null;
  capability: ApplicationUninstallCapability;
  recordState: ApplicationUninstallRecordState;
  uninstallDiagnostic: ApplicationUninstallDiagnostic | null;
  applicationPath: string | null;
  possibleRelatedPaths: string[];
  iconPath: string | null;
  runningProcesses: string[];
  totalBytes: number;
  defaultSelectedBytes: number;
  associatedDataComplete: boolean;
  components: ApplicationUninstallComponentSummary[];
}

export interface ApplicationUninstallScanResult {
  schemaVersion: number;
  scannedAtMs: number;
  supported: boolean;
  executionSupported: boolean;
  catalogActionable: boolean;
  inventoryComplete: boolean;
  catalogRevision: string | null;
  candidates: ApplicationUninstallCandidate[];
  readyCount: number;
  blockedCount: number;
  hiddenCount: number;
  relatedDirectoryCount: number;
  relatedPathScanElapsedMs: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Inspection, plan, and execution shapes
// ---------------------------------------------------------------------------

export interface ApplicationUninstallComponent {
  componentId: string;
  kind: ApplicationUninstallComponentKind;
  risk: ApplicationUninstallRisk;
  path: string | null;
  bytes: number;
  fileCount: number;
  defaultSelected: boolean;
  snapshotFingerprint: string;
}

export interface ApplicationUninstallInspection {
  schemaVersion: number;
  inspectedAtMs: number;
  applicationId: string;
  applicationName: string;
  primaryIdentifier: string;
  platform: ApplicationUninstallPlatform;
  installerKind: ApplicationUninstallInstallerKind | null;
  capability: ApplicationUninstallCapability;
  catalogRevision: string;
  components: ApplicationUninstallComponent[];
  totalBytes: number;
  defaultSelectedBytes: number;
  elapsedMs: number;
}

export interface ApplicationUninstallPlanItem {
  componentId: string;
  kind: ApplicationUninstallComponentKind;
  expectedBytes: number;
  expectedFileCount: number;
  expectedSnapshotFingerprint: string;
}

export interface ApplicationUninstallPlan {
  schemaVersion: number;
  planId: string;
  planHash: string;
  createdAtMs: number;
  applicationId: string;
  catalogRevision: string;
  items: ApplicationUninstallPlanItem[];
  expectedBytes: number;
}

export interface ApplicationUninstallBatchSelection {
  applicationId: string;
  componentIds: string[];
}

export type ApplicationCloseMode = "graceful" | "force";
export type ApplicationCloseTargetStatus = "completed" | "failed";

export interface ApplicationCloseTargetResult {
  targetId: string;
  status: ApplicationCloseTargetStatus;
  matchedProcessCount: number;
  requestedProcessCount: number;
  remainingProcesses: string[];
}

export interface ApplicationCloseBatchResult {
  mode: ApplicationCloseMode;
  matchedProcessCount: number;
  requestedProcessCount: number;
  remainingProcessCount: number;
  failedTargetCount: number;
  targets: ApplicationCloseTargetResult[];
  elapsedMs: number;
}

export interface ApplicationUninstallCloseRequest {
  applicationIds: string[];
  mode: ApplicationCloseMode;
}

export interface ApplicationUninstallCloseResponse {
  closeResult: ApplicationCloseBatchResult;
  catalog: ApplicationUninstallScanResult;
}

export interface ApplicationUninstallBatchPlan {
  schemaVersion: number;
  batchId: string;
  batchHash: string;
  createdAtMs: number;
  catalogRevision: string;
  plans: ApplicationUninstallPlan[];
  expectedBytes: number;
}

export interface ApplicationUninstallBatchPreparation {
  plan: ApplicationUninstallBatchPlan;
  preview: ApplicationUninstallBatchResult;
}

export type ApplicationUninstallExecutionStage = "validating" | "uninstalling" | "finalizing";
export type ApplicationUninstallExecutionItemStatus = "completed" | "cancelled" | "failed";

export interface ApplicationUninstallExecutionItemResult {
  applicationId: string;
  status: ApplicationUninstallExecutionItemStatus;
  releasedBytes: number;
}

export interface ApplicationUninstallExecutionProgress {
  stage: ApplicationUninstallExecutionStage;
  currentApplicationId: string | null;
  completedApplications: ApplicationUninstallExecutionItemResult[];
  completedApplicationCount: number;
  totalApplicationCount: number;
  affectedApplicationCount: number;
  failedApplicationCount: number;
  releasedBytes: number;
  elapsedMs: number;
}

export type ApplicationUninstallActionStatus = "previewed" | "completed" | "cancelled" | "failed";

export type ApplicationUninstallActionReason =
  | "applicationUnavailable"
  | "applicationRunning"
  | "processStateUnavailable"
  | "catalogChanged"
  | "componentUnavailable"
  | "componentChanged"
  | "unsupportedExecutor"
  | "executionAborted"
  | "externalUninstallerContinuing"
  | "permanentDeleteFailed"
  | "recoveryRequired"
  | "nativeInstallerFailed"
  | "removalUnconfirmed"
  | "nativeInstallerFailedAfterRemoval"
  | "verificationFailed";

export interface ApplicationUninstallActionResult {
  componentId: string;
  kind: ApplicationUninstallComponentKind;
  status: ApplicationUninstallActionStatus;
  reason: ApplicationUninstallActionReason | null;
  expectedBytes: number;
  releasedBytes: number;
}

export interface ApplicationUninstallResult {
  planId: string;
  applicationId: string;
  applicationName: string | null;
  expectedBytes: number;
  previewedBytes: number;
  releasedBytes: number;
  previewedItemCount: number;
  affectedItemCount: number;
  failedItemCount: number;
  releasedBytesIsEstimate: boolean;
  restartRequired: boolean;
  dryRun: boolean;
  actions: ApplicationUninstallActionResult[];
  historySaved: boolean;
}

export interface ApplicationUninstallBatchResult {
  batchId: string;
  expectedBytes: number;
  previewedBytes: number;
  releasedBytes: number;
  selectedApplicationCount: number;
  previewedApplicationCount: number;
  affectedApplicationCount: number;
  failedApplicationCount: number;
  previewedItemCount: number;
  affectedItemCount: number;
  failedItemCount: number;
  releasedBytesIsEstimate: boolean;
  restartRequired: boolean;
  dryRun: boolean;
  results: ApplicationUninstallResult[];
}

// ---------------------------------------------------------------------------
// Leftover shapes
// ---------------------------------------------------------------------------

export type ApplicationLeftoverSource =
  | "sandboxContainer"
  | "applicationSupport"
  | "preferences"
  | "logs"
  | "savedState"
  | "webData"
  | "applicationScripts";

export type ApplicationLeftoverConfidence = "high";

export type ApplicationLeftoverEvidence =
  | "containerMetadataVerified"
  | "formerBundleMissing"
  | "installedOwnerAbsent"
  | "exactIdentifierAssociation"
  | "filesystemSnapshotComplete";

export interface ApplicationLeftoverCandidate {
  candidateId: string;
  applicationIdentifier: string;
  applicationName: string;
  source: ApplicationLeftoverSource;
  path: string;
  bytes: number;
  fileCount: number;
  modifiedAtMs: number | null;
  confidence: ApplicationLeftoverConfidence;
  defaultSelected: boolean;
  evidence: ApplicationLeftoverEvidence[];
  snapshotFingerprint: string;
}

export interface ApplicationLeftoverScanResult {
  schemaVersion: number;
  scannedAtMs: number;
  supported: boolean;
  inventoryComplete: boolean;
  accessLimited: boolean;
  candidates: ApplicationLeftoverCandidate[];
  totalBytes: number;
  totalFileCount: number;
  skippedCount: number;
  elapsedMs: number;
}

export interface ApplicationLeftoverPlanItem {
  candidateId: string;
  expectedBytes: number;
  expectedFileCount: number;
  expectedSnapshotFingerprint: string;
}

export type ApplicationLeftoverActionStatus = "previewed" | "completed" | "cancelled" | "failed";

export type ApplicationLeftoverActionReason =
  | "candidateChanged"
  | "ownerReappeared"
  | "applicationRunning"
  | "permanentDeleteFailed";

export interface ApplicationLeftoverActionResult {
  candidateId: string;
  applicationIdentifier: string;
  applicationName: string;
  status: ApplicationLeftoverActionStatus;
  reason: ApplicationLeftoverActionReason | null;
  expectedBytes: number;
  releasedBytes: number;
}

export interface ApplicationLeftoverResult {
  planId: string;
  expectedBytes: number;
  releasedBytes: number;
  affectedItemCount: number;
  failedItemCount: number;
  dryRun: boolean;
  actions: ApplicationLeftoverActionResult[];
  historySaved: boolean;
}

export interface ApplicationIcon {
  path: string;
  dataUrl: string;
}

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

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

/** Describe one application's uninstall identity metadata. */
export async function systoolsUninstallDescribeIdentity(
  applicationId: string,
  catalogRevision: string
): Promise<ApplicationUninstallIdentity> {
  return await invokeCommand<
    { applicationId: string; catalogRevision: string },
    ApplicationUninstallIdentity
  >("systools_uninstall_describe_identity", { applicationId, catalogRevision });
}

/** Ask the listed applications to close before uninstalling. */
export async function systoolsUninstallCloseApplications(
  request: ApplicationUninstallCloseRequest,
  catalogRevision: string
): Promise<ApplicationUninstallCloseResponse> {
  return await invokeCommand<
    { request: ApplicationUninstallCloseRequest; catalogRevision: string },
    ApplicationUninstallCloseResponse
  >("systools_uninstall_close_applications", { request, catalogRevision });
}

/** Turn uninstall selections into a reviewable batch plan. */
export async function systoolsUninstallPrepareBatch(
  selections: ApplicationUninstallBatchSelection[],
  catalogRevision: string
): Promise<ApplicationUninstallBatchPreparation> {
  return await invokeCommand<
    { selections: ApplicationUninstallBatchSelection[]; catalogRevision: string },
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

/** Remove a stale uninstall registration without touching the application. */
export async function systoolsUninstallRemoveRecord(applicationId: string): Promise<void> {
  return await invokeCommand<{ applicationId: string }, void>("systools_uninstall_remove_record", {
    applicationId,
  });
}

/** Open the Windows "Installed apps" settings page. */
export async function systoolsUninstallOpenWindowsApps(): Promise<void> {
  return await invokeCommand<Record<string, never>, void>(
    "systools_uninstall_open_windows_apps",
    {}
  );
}

/** Scan for files and registry entries left behind by removed applications. */
export async function systoolsLeftoversScan(): Promise<ApplicationLeftoverScanResult> {
  return await invokeCommand<Record<string, never>, ApplicationLeftoverScanResult>(
    "systools_leftovers_scan",
    {}
  );
}

/** Permanently delete the reviewed leftovers, optionally as a dry run. */
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

/** Resolve application icons for a batch of executable paths. */
export async function systoolsApplicationIcons(paths: string[]): Promise<ApplicationIcon[]> {
  return await invokeCommand<{ paths: string[] }, ApplicationIcon[]>("systools_application_icons", {
    paths,
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure and unit-friendly)
// ---------------------------------------------------------------------------

export type ApplicationSourceGroup = "registry" | "store" | "winget";
export type ApplicationSourceFilter = ApplicationSourceGroup | "all";
export type ApplicationSort = "name" | "size" | "installDate";
export type ApplicationSortDirection = "asc" | "desc";

export interface ApplicationFilter {
  query: string;
  publisher: string | null;
  source: ApplicationSourceFilter;
}

const SOURCE_GROUP_BY_KIND: Record<ApplicationUninstallInventorySource, ApplicationSourceGroup> = {
  windowsRegistry: "registry",
  windowsMsi: "registry",
  windowsAppx: "store",
  winget: "winget",
  steam: "winget",
  scoop: "winget",
  chocolatey: "winget",
};

const SOURCE_GROUP_PRIORITY: readonly ApplicationSourceGroup[] = ["registry", "store", "winget"];

/** i18n key suffix for an inventory source label. */
export function applicationSourceLabelKey(source: ApplicationUninstallInventorySource): string {
  return source;
}

/**
 * Collapses every inventory source onto the three source-filter buckets and
 * returns the most specific one (registry, then store, then package manager).
 */
export function groupSourceKinds(
  candidate: Pick<ApplicationUninstallCandidate, "sourceIdentities">
): ApplicationSourceGroup {
  const groups = new Set(
    candidate.sourceIdentities.map((identity) => SOURCE_GROUP_BY_KIND[identity.source])
  );
  return SOURCE_GROUP_PRIORITY.find((group) => groups.has(group)) ?? "registry";
}

/** Bytes shown for one catalog row; component totals win over catalog estimates. */
export function applicationBytes(
  candidate: Pick<ApplicationUninstallCandidate, "totalBytes" | "estimatedBytes">
): number {
  return candidate.totalBytes > 0 ? candidate.totalBytes : candidate.estimatedBytes;
}

/** Component IDs sent when a row is selected: the plan's default selection. */
export function defaultSelectedComponentIds(
  candidate: Pick<ApplicationUninstallCandidate, "components">
): string[] {
  return candidate.components
    .filter((component) => component.defaultSelected)
    .map((component) => component.componentId);
}

/** Whether the catalog allows starting an uninstall for this row. */
export function canSelectApplication(
  candidate: ApplicationUninstallCandidate,
  executionSupported: boolean
): boolean {
  if (!executionSupported) return false;
  if (candidate.capability === "protectedApplication" || candidate.capability === "viewOnly") {
    return false;
  }
  return defaultSelectedComponentIds(candidate).length > 0;
}

function compareName(left: ApplicationUninstallCandidate, right: ApplicationUninstallCandidate) {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function compareOptionalNumber(
  left: number | null,
  right: number | null,
  direction: 1 | -1,
  zeroIsUnknown: boolean
) {
  if (left === right) return 0;
  // Unknown evidence sorts last in either direction instead of pretending to
  // be the smallest or oldest value.
  if (left === null || (zeroIsUnknown && left === 0)) return 1;
  if (right === null || (zeroIsUnknown && right === 0)) return -1;
  return (left - right) * direction;
}

/** Copy and sort without mutating the caller's array. */
export function sortApplications(
  applications: readonly ApplicationUninstallCandidate[],
  sort: ApplicationSort,
  direction: ApplicationSortDirection
): ApplicationUninstallCandidate[] {
  const sign: 1 | -1 = direction === "asc" ? 1 : -1;
  return [...applications].sort((left, right) => {
    let comparison = 0;
    if (sort === "name") {
      comparison = compareName(left, right) * sign;
    } else if (sort === "size") {
      comparison = compareOptionalNumber(
        applicationBytes(left),
        applicationBytes(right),
        sign,
        true
      );
    } else {
      comparison = compareOptionalNumber(
        left.dates.installed?.timestampMs ?? null,
        right.dates.installed?.timestampMs ?? null,
        sign,
        false
      );
    }
    return comparison || compareName(left, right);
  });
}

/** Search by name, publisher, and primary identifier, then apply facet filters. */
export function filterApplications(
  applications: readonly ApplicationUninstallCandidate[],
  filter: ApplicationFilter
): ApplicationUninstallCandidate[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return applications.filter((candidate) => {
    if (filter.publisher && candidate.publisher !== filter.publisher) return false;
    if (filter.source !== "all" && groupSourceKinds(candidate) !== filter.source) return false;
    if (!query) return true;
    const identity = [candidate.name, candidate.publisher, candidate.primaryIdentifier].filter(
      (value): value is string => Boolean(value)
    );
    return identity.some((value) => value.toLocaleLowerCase().includes(query));
  });
}

/** Unique publishers, sorted for a stable select menu. */
export function applicationPublishers(
  applications: readonly ApplicationUninstallCandidate[]
): string[] {
  const publishers = new Set<string>();
  for (const candidate of applications) {
    if (candidate.publisher) publishers.add(candidate.publisher);
  }
  return [...publishers].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" })
  );
}

/** Locale-aware calendar date for catalog evidence. */
export function formatApplicationDate(timestampMs: number, language?: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(timestampMs));
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

const SYSTOOLS_ERROR_CODES = new Set<string>([
  "invalidInput",
  "operationBusy",
  "operationCancelled",
  "operationFailed",
  "permissionDenied",
  "persistenceFailed",
  "taskJoinFailed",
  "notImplemented",
]);

/** Narrows an `invoke` rejection to the stable native error shape. */
export function parseSystoolsError(error: unknown): SystoolsError | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code !== "string" || !SYSTOOLS_ERROR_CODES.has(candidate.code)) {
    return null;
  }
  const details =
    typeof candidate.details === "object" && candidate.details !== null
      ? (candidate.details as Record<string, string>)
      : {};
  return {
    code: candidate.code as SystoolsError["code"],
    details,
    retryable: candidate.retryable === true,
  };
}

/**
 * A UAC dismissal surfaces either as `operationCancelled` or as a permission
 * error whose details mention cancellation. Both must read as "cancelled".
 */
export function isCancellationError(error: SystoolsError): boolean {
  if (error.code === "operationCancelled") return true;
  return Object.values(error.details).some((value) => /cancel/i.test(value));
}

/** i18n key for a command rejection; UAC cancellations read as cancellations. */
export function systoolsErrorKey(error: unknown): string {
  const parsed = parseSystoolsError(error);
  if (!parsed) return "systools.uninstall.errors.unknown";
  if (isCancellationError(parsed)) return "systools.uninstall.errors.cancelled";
  return `systools.uninstall.errors.${parsed.code}`;
}

export const APPLICATION_ICON_BATCH_SIZE = 100;
