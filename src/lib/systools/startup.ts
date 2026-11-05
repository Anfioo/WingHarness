// Startup management DTOs and thin command wrappers.
//
// The Rust DTOs are camelCase; these types mirror them one-to-one so the page
// never has to work with opaque payloads.

import {
  systoolsStartupCancelChange,
  systoolsStartupCancelScan,
  systoolsStartupExecuteChange,
  systoolsStartupPrepareChange,
  systoolsStartupScan,
} from "@/commands/services/systools";

export type StartupSourceKind =
  | "registryRun"
  | "startupFolder"
  | "scheduledTask"
  | "service"
  | "packagedStartupTask"
  | "advancedAutoRun";

export type StartupScope = "currentUser" | "user" | "allUsers" | "machine" | "system";

export type StartupTrigger =
  | "boot"
  | "userLogon"
  | "scheduled"
  | "event"
  | "keepAlive"
  | "shellLoad"
  | "applicationLaunch"
  | "unknown";

export type StartupConfiguredState = "enabled" | "disabled" | "unknown" | "notApplicable";
export type StartupRuntimeState = "running" | "stopped" | "loaded" | "unloaded" | "unknown";
export type StartupControlCapability =
  | "toggleable"
  | "elevationRequired"
  | "removeOnly"
  | "systemManaged"
  | "policyManaged"
  | "viewOnly";
export type StartupTrustState = "system" | "verified" | "invalid" | "unsigned" | "unknown";
export type StartupIdentityConfidence = "exact" | "strong" | "probable" | "unresolved";
export type StartupSummarySource =
  | "serviceDescription"
  | "taskDescription"
  | "packageManifest"
  | "versionInfo"
  | "sourceLabel"
  | "unavailable";
export type StartupTargetKind =
  | "executable"
  | "application"
  | "script"
  | "service"
  | "task"
  | "other"
  | "unknown";
export type StartupDiagnosticCode =
  | "accessDenied"
  | "invalidData"
  | "missingIdentity"
  | "missingTarget"
  | "stateUnavailable"
  | "unsupportedFormat";
export type StartupCoverageStatus = "complete" | "partial" | "unavailable" | "failed" | "cancelled";
export type StartupCoverageReason =
  | "accessDenied"
  | "apiUnavailable"
  | "cancelled"
  | "invalidData"
  | "notImplemented"
  | "stateUnavailable"
  | "unsupportedOperatingSystem";
export type StartupAggregateConfiguredState =
  | "allEnabled"
  | "partiallyEnabled"
  | "allDisabled"
  | "unknown";
export type StartupAggregateControlState =
  | "allToggleable"
  | "requiresElevation"
  | "partiallyManageable"
  | "viewOnly";

export interface StartupTarget {
  kind: StartupTargetKind;
  path: string | null;
  executableName: string | null;
  arguments: string[];
}

export interface StartupArtifact {
  itemId: string;
  sourceId: string;
  sourceKind: StartupSourceKind;
  scope: StartupScope;
  triggers: StartupTrigger[];
  displayName: string;
  configurationPath: string | null;
  target: StartupTarget;
  ownerName: string | null;
  publisher: string | null;
  summary: string | null;
  summarySource: StartupSummarySource;
  version: string | null;
  iconPath: string | null;
  identityConfidence: StartupIdentityConfidence;
  configuredState: StartupConfiguredState;
  runtimeState: StartupRuntimeState;
  controlCapability: StartupControlCapability;
  trust: StartupTrustState;
  modifiedAtMs: number | null;
  diagnostics: StartupDiagnosticCode[];
  removalSupported: boolean;
  removableOrphan: boolean;
}

export interface StartupOwnerGroup {
  groupId: string;
  name: string;
  publisher: string | null;
  summary: string | null;
  summarySource: StartupSummarySource;
  version: string | null;
  iconPath: string | null;
  identityConfidence: StartupIdentityConfidence;
  itemIds: string[];
  sourceKinds: StartupSourceKind[];
  triggers: StartupTrigger[];
  scopes: StartupScope[];
  configuredState: StartupAggregateConfiguredState;
  controlState: StartupAggregateControlState;
  systemItem: boolean;
}

export interface StartupSourceCoverage {
  sourceId: string;
  required: boolean;
  status: StartupCoverageStatus;
  reason: StartupCoverageReason | null;
  itemCount: number;
  elapsedMs: number;
}

export interface StartupCatalogSummary {
  itemCount: number;
  groupCount: number;
  enabledCount: number;
  disabledCount: number;
  unknownStateCount: number;
  elevationRequiredCount: number;
  systemItemCount: number;
}

export interface StartupCatalog {
  schemaVersion: number;
  scanId: string;
  catalogRevision: string;
  scannedAtMs: number;
  complete: boolean;
  artifacts: StartupArtifact[];
  groups: StartupOwnerGroup[];
  coverage: StartupSourceCoverage[];
  summary: StartupCatalogSummary;
  elapsedMs: number;
}

export type StartupDesiredState = "enabled" | "disabled" | "removed";

export interface StartupChangeSelection {
  scanId: string;
  itemIds: string[];
  desiredState: StartupDesiredState;
}

export type StartupChangeWarning = "affectsOtherTriggers" | "itemCurrentlyRunning";

export type StartupChangeSkipReason =
  | "alreadyInDesiredState"
  | "catalogExpired"
  | "itemChanged"
  | "itemMissing"
  | "stateUnknown"
  | "unsupportedCapability"
  | "requiresElevation"
  | "targetUnavailable";

export interface StartupChangePlanItem {
  itemId: string;
  displayName: string;
  sourceKind: StartupSourceKind;
  scope: StartupScope;
  previousState: StartupConfiguredState;
  desiredState: StartupDesiredState;
  warnings: StartupChangeWarning[];
  requiresElevation: boolean;
}

export interface StartupChangeSkippedItem {
  itemId: string;
  displayName: string;
  reason: StartupChangeSkipReason;
}

export interface StartupChangePlan {
  schemaVersion: number;
  planId: string;
  scanId: string;
  catalogRevision: string;
  createdAtMs: number;
  expiresAtMs: number;
  desiredState: StartupDesiredState;
  items: StartupChangePlanItem[];
  skippedItems: StartupChangeSkippedItem[];
  requiresConfirmation: boolean;
}

export type StartupChangeOutcomeStatus = "changed" | "unchanged" | "failed";

export type StartupChangeFailureReason =
  | "itemChanged"
  | "permissionDenied"
  | "userCancelled"
  | "unsupported"
  | "verificationFailed"
  | "platformFailure";

export interface StartupChangeItemResult {
  itemId: string;
  status: StartupChangeOutcomeStatus;
  configuredState: StartupConfiguredState;
  verified: boolean;
  failureReason: StartupChangeFailureReason | null;
}

export interface StartupChangeResult {
  planId: string;
  changedCount: number;
  failedCount: number;
  items: StartupChangeItemResult[];
  catalog: StartupCatalog | null;
}

/** Payload of one native source finishing during a scan. */
export interface StartupScanProgress {
  sourceId: string;
  status: StartupCoverageStatus;
  /** Startup items found so far across every finished source. */
  itemsFound: number;
  completedSources: number;
  totalSources: number;
  elapsedMs: number;
}

/** Emitted once per finished source while the scan is still running. */
export const STARTUP_SCAN_PROGRESS_EVENT = "systools:startup-scan-progress";

/** Mirrors the native source count so the bar has a denominator before the first event. */
export const STARTUP_SCAN_SOURCE_TOTAL = 7;

/** Scan every startup source. */
export async function scanStartupItems(): Promise<StartupCatalog> {
  return (await systoolsStartupScan()) as unknown as StartupCatalog;
}

/** Stop an in-flight startup scan. */
export async function cancelStartupScan(): Promise<void> {
  await systoolsStartupCancelScan();
}

/** Turn a selection into a reviewable change plan. */
export async function prepareStartupChange(
  selection: StartupChangeSelection
): Promise<StartupChangePlan> {
  // The command service still types its payloads as opaque records.
  return (await systoolsStartupPrepareChange(
    selection as unknown as Record<string, unknown>
  )) as unknown as StartupChangePlan;
}

/** Apply a prepared change plan. */
export async function executeStartupChange(
  planId: string,
  authorizationPrompt: string
): Promise<StartupChangeResult> {
  return (await systoolsStartupExecuteChange(
    planId,
    authorizationPrompt
  )) as unknown as StartupChangeResult;
}

/** Discard a prepared change plan. */
export async function cancelStartupChange(): Promise<void> {
  await systoolsStartupCancelChange();
}

/** Top-level source filter used by the page. */
export type StartupSourceFilter =
  | "all"
  | "registry"
  | "folder"
  | "service"
  | "task"
  | "app"
  | "advanced";

export const STARTUP_SOURCE_FILTERS: StartupSourceFilter[] = [
  "all",
  "registry",
  "folder",
  "service",
  "task",
  "app",
  "advanced",
];

/** Map one native source kind onto its page filter. */
export function sourceFilterOf(kind: StartupSourceKind): Exclude<StartupSourceFilter, "all"> {
  switch (kind) {
    case "registryRun":
      return "registry";
    case "startupFolder":
      return "folder";
    case "service":
      return "service";
    case "scheduledTask":
      return "task";
    case "packagedStartupTask":
      return "app";
    case "advancedAutoRun":
      return "advanced";
  }
}

/** Whether an item matches the active source filter. */
export function matchesSourceFilter(
  artifact: StartupArtifact,
  filter: StartupSourceFilter
): boolean {
  return filter === "all" || sourceFilterOf(artifact.sourceKind) === filter;
}

export type StartupRiskLevel = "low" | "medium" | "high";

/** Presentation-only risk level derived from native control and trust facts. */
export function startupRisk(artifact: StartupArtifact): StartupRiskLevel {
  if (
    artifact.controlCapability === "systemManaged" ||
    artifact.controlCapability === "policyManaged" ||
    artifact.trust === "invalid"
  ) {
    return "high";
  }
  if (
    artifact.controlCapability === "elevationRequired" ||
    artifact.trust === "unknown" ||
    artifact.trust === "unsigned" ||
    artifact.scope === "system" ||
    artifact.scope === "machine"
  ) {
    return "medium";
  }
  return "low";
}

/** Whether the page may offer a toggle for this item. */
export function isStartupToggleable(artifact: StartupArtifact): boolean {
  return (
    artifact.controlCapability === "toggleable" ||
    artifact.controlCapability === "elevationRequired"
  );
}

/** The configured state an enabled toggle would request. */
export function nextDesiredState(artifact: StartupArtifact): StartupDesiredState {
  return artifact.configuredState === "enabled" ? "disabled" : "enabled";
}
