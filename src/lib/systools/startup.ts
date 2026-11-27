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
  "executable" | "application" | "script" | "service" | "task" | "other" | "unknown";
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
  "allEnabled" | "partiallyEnabled" | "allDisabled" | "unknown";
export type StartupAggregateControlState =
  "allToggleable" | "requiresElevation" | "partiallyManageable" | "viewOnly";

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

/** Top-level source filter used for source badges and plan rows. */
export type StartupSourceFilter =
  "all" | "registry" | "folder" | "service" | "task" | "app" | "advanced";

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

/** Aggregated state filter shown above the startup list. */
export type StartupStateFilter = "all" | "enabled" | "disabled" | "leftover";

export const STARTUP_STATE_FILTERS: StartupStateFilter[] = [
  "all",
  "enabled",
  "disabled",
  "leftover",
];

export type StartupGroupState = "enabled" | "disabled" | "mixed" | "unknown";

export interface StartupStateCounts {
  all: number;
  enabled: number;
  disabled: number;
  leftover: number;
}

/** Artifacts the catalog grouped under one owning application. */
export function artifactsForGroup(
  group: StartupOwnerGroup,
  artifactsById: ReadonlyMap<string, StartupArtifact>
): StartupArtifact[] {
  const artifacts: StartupArtifact[] = [];
  for (const itemId of group.itemIds) {
    const artifact = artifactsById.get(itemId);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

/** Whether a row may offer a switch for this item. */
export function canToggleArtifact(artifact: StartupArtifact): boolean {
  return (
    isStartupToggleable(artifact) &&
    (artifact.configuredState === "enabled" || artifact.configuredState === "disabled")
  );
}

/** An entry whose target is gone, or a registration Windows left behind. */
export function isLeftoverArtifact(artifact: StartupArtifact): boolean {
  if (artifact.removableOrphan) return true;
  return (
    artifact.diagnostics.includes("missingTarget") &&
    !artifact.removalSupported &&
    artifact.controlCapability !== "systemManaged" &&
    artifact.controlCapability !== "policyManaged"
  );
}

/** Read-only service entries worth showing even though they cannot be toggled. */
function isInformativeArtifact(artifact: StartupArtifact): boolean {
  return (
    artifact.sourceKind === "service" &&
    (artifact.controlCapability === "viewOnly" || artifact.controlCapability === "systemManaged")
  );
}

/** Artifacts of a group the list actually renders. */
export function visibleArtifactsForGroup(
  group: StartupOwnerGroup,
  artifactsById: ReadonlyMap<string, StartupArtifact>
): StartupArtifact[] {
  return artifactsForGroup(group, artifactsById).filter(
    (artifact) =>
      canToggleArtifact(artifact) ||
      artifact.removalSupported ||
      isLeftoverArtifact(artifact) ||
      isInformativeArtifact(artifact)
  );
}

export function manageableArtifactsForGroup(
  group: StartupOwnerGroup,
  artifactsById: ReadonlyMap<string, StartupArtifact>
): StartupArtifact[] {
  return artifactsForGroup(group, artifactsById).filter(canToggleArtifact);
}

/** The switch state of a whole application. */
export function startupGroupState(
  group: StartupOwnerGroup,
  artifactsById: ReadonlyMap<string, StartupArtifact>
): StartupGroupState {
  const manageable = manageableArtifactsForGroup(group, artifactsById);
  const items = manageable.length ? manageable : visibleArtifactsForGroup(group, artifactsById);
  const known = items.filter(
    (artifact) => artifact.configuredState === "enabled" || artifact.configuredState === "disabled"
  );
  if (known.length === 0 || known.length !== items.length) return "unknown";
  const enabled = known.filter((artifact) => artifact.configuredState === "enabled").length;
  if (enabled === 0) return "disabled";
  if (enabled === known.length) return "enabled";
  return "mixed";
}

/** Windows' own services are hidden until the user asks for them. */
export function isSystemStartupGroup(
  group: StartupOwnerGroup,
  artifactsById: ReadonlyMap<string, StartupArtifact>
): boolean {
  const artifacts = artifactsForGroup(group, artifactsById);
  return (
    group.systemItem ||
    (artifacts.length > 0 &&
      artifacts.every(
        (artifact) =>
          artifact.sourceKind === "service" && artifact.controlCapability === "systemManaged"
      ))
  );
}

/** Groups the page lists: non-empty, with system groups hidden by default. */
export function visibleStartupGroups(
  groups: readonly StartupOwnerGroup[],
  artifactsById: ReadonlyMap<string, StartupArtifact>,
  showSystemItems: boolean
): StartupOwnerGroup[] {
  return groups.filter((group) => {
    if (visibleArtifactsForGroup(group, artifactsById).length === 0) return false;
    return showSystemItems || !isSystemStartupGroup(group, artifactsById);
  });
}

/** Counts behind the state tabs, over the groups the page lists. */
export function startupStateCounts(
  groups: readonly StartupOwnerGroup[],
  artifactsById: ReadonlyMap<string, StartupArtifact>
): StartupStateCounts {
  const counts: StartupStateCounts = { all: groups.length, enabled: 0, disabled: 0, leftover: 0 };
  for (const group of groups) {
    const state = startupGroupState(group, artifactsById);
    if (state === "enabled") counts.enabled += 1;
    if (state === "disabled") counts.disabled += 1;
    if (artifactsForGroup(group, artifactsById).some(isLeftoverArtifact)) counts.leftover += 1;
  }
  return counts;
}

/** Applies the state tab and the search box, then sorts by name. */
export function filterStartupGroups(
  groups: readonly StartupOwnerGroup[],
  artifactsById: ReadonlyMap<string, StartupArtifact>,
  query: string,
  filter: StartupStateFilter
): StartupOwnerGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  return groups
    .filter((group) => {
      if (filter === "leftover") {
        if (!artifactsForGroup(group, artifactsById).some(isLeftoverArtifact)) return false;
      } else if (filter !== "all" && startupGroupState(group, artifactsById) !== filter) {
        return false;
      }
      if (!needle) return true;
      const values: (string | null)[] = [group.name, group.publisher, group.summary];
      for (const artifact of artifactsForGroup(group, artifactsById)) {
        values.push(artifact.displayName, artifact.target.path, artifact.target.executableName);
      }
      return values.some(
        (value) => typeof value === "string" && value.toLocaleLowerCase().includes(needle)
      );
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

/** A one-line owner description, skipping the registry's opaque id-shaped publishers. */
export function startupGroupSubtitle(group: StartupOwnerGroup): string | null {
  if (group.summary) return group.summary;
  if (group.publisher && !/^[A-Z0-9]{10}$/.test(group.publisher)) return group.publisher;
  return null;
}

/** The folder that best represents a group for "show in folder". */
export function startupRevealPath(
  group: StartupOwnerGroup,
  artifactsById: ReadonlyMap<string, StartupArtifact>
): string | null {
  const artifacts = visibleArtifactsForGroup(group, artifactsById);
  for (const artifact of artifacts) {
    if (artifact.configurationPath) return artifact.configurationPath;
  }
  const withTargets = artifacts.filter(
    (artifact) => !artifact.diagnostics.includes("missingTarget")
  );
  if (group.iconPath && withTargets.length) return group.iconPath;
  for (const artifact of withTargets) {
    if (artifact.target.path) return artifact.target.path;
  }
  return null;
}

/** The folder or file that best represents one artifact for "show in folder". */
export function startupArtifactRevealPath(artifact: StartupArtifact): string | null {
  if (artifact.configurationPath) return artifact.configurationPath;
  if (artifact.diagnostics.includes("missingTarget")) return null;
  return artifact.target.path;
}

/** The state a group switch would request. */
export function nextGroupDesiredState(state: StartupGroupState): StartupDesiredState {
  return state === "enabled" ? "disabled" : "enabled";
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
