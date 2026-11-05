// Typed duplicate-files layer for the systools duplicates tab.
//
// Shapes mirror `systools-core/src/storage/duplicates/models.rs` and
// `systools-core/src/filesystem/models.rs` (serde camelCase). The command
// service still exposes permissive placeholder payloads, so every result is
// narrowed once at this boundary. The selection helpers mirror the Core
// policy: copies in protected locations are never selected and every group
// keeps at least one copy.

import {
  systoolsDuplicatesCancel,
  systoolsDuplicatesDelete,
  systoolsDuplicatesPage,
  systoolsDuplicatesScan,
  systoolsPrefsGet,
  systoolsRevealInFileManager,
  systoolsSystemDisk,
  systoolsVolumesList,
} from "@/commands/services/systools";
import { openPath } from "@/commands";
import type {
  ScanNameExclusion,
  SystoolsError,
  SystoolsPrefs,
} from "@/commands/services/systools/types";
import { isCancellationError, parseSystoolsError } from "@/lib/systools/applications";

// ---------------------------------------------------------------------------
// Events and paging
// ---------------------------------------------------------------------------

export const DUPLICATE_PROGRESS_EVENT = "systools:duplicate-progress";
export const DUPLICATE_GROUPS_EVENT = "systools:duplicate-groups";

/** Groups requested per native page. */
export const DUPLICATE_PAGE_SIZE = 40;

// ---------------------------------------------------------------------------
// DTOs (camelCase on the wire)
// ---------------------------------------------------------------------------

export type DuplicateScanLocationMode = "cleanable" | "protected";

export type DuplicateScanLocation = {
  path: string;
  mode: DuplicateScanLocationMode;
};

export type DuplicateEntryDeletePolicy = "cleanable" | "protected";

export type DuplicateGroupKind = "file" | "directory";

export type DuplicateFileEntry = {
  name: string;
  path: string;
  parentPath: string;
  /** Logical content length used for duplicate identity and delete preflight. */
  bytes: number;
  /** Physical storage charged to the volume and used for disk-space estimates. */
  allocatedBytes: number;
  modifiedAtMs: number | null;
  deletePolicy: DuplicateEntryDeletePolicy;
};

export type DuplicateGroup = {
  id: string;
  /** Opaque exact-match proof token; never treated as a reusable checksum. */
  hash: string;
  kind: DuplicateGroupKind;
  bytesPerFile: number;
  fileCountPerEntry: number;
  reclaimableBytes: number;
  entries: DuplicateFileEntry[];
};

export type DuplicateFilesResult = {
  scanId: number;
  roots: string[];
  protectedRoots: string[];
  scannedAtMs: number;
  scannedFileCount: number;
  skippedCount: number;
  duplicateFileCount: number;
  totalDuplicateBytes: number;
  reclaimableBytes: number;
  totalGroupCount: number;
  returnedGroupCount: number;
  truncated: boolean;
  groups: DuplicateGroup[];
};

export type DuplicateGroupBatch = {
  operationId: number;
  sequence: number;
  groups: DuplicateGroup[];
  foundGroupCount: number;
  foundFileCount: number;
  foundTotalBytes: number;
  foundReclaimableBytes: number;
  elapsedMs: number;
};

export type DuplicateGroupPage = {
  scanId: number;
  offset: number;
  nextOffset: number | null;
  totalCount: number;
  groups: DuplicateGroup[];
};

export type DuplicateScanStage = "analyzing" | "validatingFiles" | "hashingFiles";

/** Payload of `systools:duplicate-progress` (`shared::progress::TraversalProgress`). */
export type DuplicateScanProgress = {
  operationId: number;
  currentStage: DuplicateScanStage;
  currentPath: string;
  itemsScanned: number;
  bytesScanned: number;
  completedSteps: number;
  totalSteps: number;
  foundItems: number;
  foundBytes: number;
  elapsedMs: number;
};

export type PermanentDeleteFailureReason =
  | "accessDenied"
  | "resourceBusy"
  | "itemChanged"
  | "protected"
  | "notFound"
  | "other";

export type PermanentDeleteFailureStage =
  | "validate"
  | "prepareTarget"
  | "createStaging"
  | "moveToStaging"
  | "remove";

export type PermanentDeleteFailure = {
  path: string;
  message: string;
  reason: PermanentDeleteFailureReason;
  stage: PermanentDeleteFailureStage;
  nativeCode: number | null;
  partial: boolean;
  remainingRestored: boolean;
};

export type PermanentDeleteCandidate = {
  path: string;
  /** Logical content length used only to reject stale file selections. */
  expectedBytes: number;
  expectedModifiedAtMs: number | null;
};

export type PermanentDeleteBatchResult = {
  removedPaths: string[];
  /** Entries already absent are reconciled without counting reclaimed storage. */
  alreadyAbsentPaths?: string[];
  failed: PermanentDeleteFailure[];
  /** Only serialized when true. */
  releasedBytesIsEstimate?: boolean;
  releasedBytes: number;
};

export type DuplicateVolume = {
  name: string;
  mountPoint: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
};

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/**
 * The frozen command service types `scanId` as a string, while the native
 * command takes a `u64`. Tauri deserializes arguments strictly, so the numeric
 * value must cross the boundary unchanged.
 *
 * INBOX: the service should type `scanId` as `number`; this cast can then go.
 */
export function duplicateScanIdArg(scanId: number): string {
  return scanId as unknown as string;
}

/** Scan the given locations for duplicate files and directories. */
export async function scanDuplicates(
  locations: DuplicateScanLocation[],
  minimumBytes: number,
  excludedPaths: string[],
  excludedNames: ScanNameExclusion[]
): Promise<DuplicateFilesResult> {
  return (await systoolsDuplicatesScan(
    locations,
    minimumBytes,
    excludedPaths,
    excludedNames
  )) as unknown as DuplicateFilesResult;
}

/** Stop an in-flight duplicate scan. */
export async function cancelDuplicateScan(): Promise<void> {
  await systoolsDuplicatesCancel();
}

/** Read one page of groups from the active scan session. */
export async function pageDuplicates(
  scanId: number,
  offset: number,
  limit: number = DUPLICATE_PAGE_SIZE
): Promise<DuplicateGroupPage> {
  return (await systoolsDuplicatesPage(
    duplicateScanIdArg(scanId),
    offset,
    limit
  )) as unknown as DuplicateGroupPage;
}

/** Permanently delete the selected duplicate copies. */
export async function deleteDuplicates(
  scanId: number,
  candidates: PermanentDeleteCandidate[]
): Promise<PermanentDeleteBatchResult> {
  return (await systoolsDuplicatesDelete(
    duplicateScanIdArg(scanId),
    candidates
  )) as unknown as PermanentDeleteBatchResult;
}

/** Reveals one duplicate copy in Windows File Explorer. */
export async function revealDuplicateEntry(path: string): Promise<void> {
  await systoolsRevealInFileManager(path);
}

/** Opens one duplicate copy with its registered default handler. */
export async function openDuplicateFile(path: string): Promise<void> {
  await openPath(path);
}

/** Persisted scan exclusions shared by every systools tool. */
export async function loadDuplicatePrefs(): Promise<SystoolsPrefs> {
  const prefs = await systoolsPrefsGet();
  return {
    excludedPaths: Array.isArray(prefs.excludedPaths) ? prefs.excludedPaths : [],
    excludedNames: Array.isArray(prefs.excludedNames) ? prefs.excludedNames : [],
  };
}

/** Mounted volumes, used to add drive roots as scan locations. */
export async function listDuplicateVolumes(): Promise<DuplicateVolume[]> {
  const volumes = (await systoolsVolumesList(false)) as unknown as DuplicateVolume[];
  return volumes.filter(
    (volume) => typeof volume?.mountPoint === "string" && volume.mountPoint.length > 0
  );
}

/** The volume holding the Windows system drive. */
export async function systemDuplicateVolume(): Promise<DuplicateVolume> {
  return (await systoolsSystemDisk()) as unknown as DuplicateVolume;
}

// ---------------------------------------------------------------------------
// Keeper rules (localized as "keep ..." so the smart select is unambiguous)
// ---------------------------------------------------------------------------

export const DUPLICATE_KEEPER_RULES = ["newestModified", "oldestModified", "shortestPath"] as const;

export type DuplicateKeeperRule = (typeof DUPLICATE_KEEPER_RULES)[number];

export const DEFAULT_DUPLICATE_KEEPER_RULE: DuplicateKeeperRule = "shortestPath";

function compareShortestPath(left: DuplicateFileEntry, right: DuplicateFileEntry): number {
  return (
    left.path.length - right.path.length ||
    left.path.localeCompare(right.path, undefined, { numeric: true })
  );
}

/**
 * Files without modification times sort after known values. Stable path
 * ordering resolves groups where every timestamp is unavailable.
 */
function compareModifiedTime(
  left: DuplicateFileEntry,
  right: DuplicateFileEntry,
  newestFirst: boolean
): number {
  if (left.modifiedAtMs === null && right.modifiedAtMs === null) return 0;
  if (left.modifiedAtMs === null) return 1;
  if (right.modifiedAtMs === null) return -1;
  return newestFirst
    ? right.modifiedAtMs - left.modifiedAtMs
    : left.modifiedAtMs - right.modifiedAtMs;
}

function compareEntries(
  left: DuplicateFileEntry,
  right: DuplicateFileEntry,
  rule: DuplicateKeeperRule
): number {
  if (rule === "oldestModified") {
    return compareModifiedTime(left, right, false) || compareShortestPath(left, right);
  }
  if (rule === "newestModified") {
    return compareModifiedTime(left, right, true) || compareShortestPath(left, right);
  }
  return compareShortestPath(left, right);
}

/** The copy the current rule keeps. */
export function keeperEntry(
  entries: readonly DuplicateFileEntry[],
  rule: DuplicateKeeperRule
): DuplicateFileEntry | undefined {
  return [...entries].sort((left, right) => compareEntries(left, right, rule))[0];
}

/**
 * The copies smart selection marks for deletion: every cleanable copy when a
 * protected location already supplies the keeper, otherwise every copy except
 * the suggested keeper.
 */
export function suggestedGroupPaths(group: DuplicateGroup, rule: DuplicateKeeperRule): string[] {
  if (group.entries.some((entry) => entry.deletePolicy === "protected")) {
    return group.entries
      .filter((entry) => entry.deletePolicy === "cleanable")
      .map((entry) => entry.path);
  }
  const keeper = keeperEntry(group.entries, rule);
  return group.entries.filter((entry) => entry.path !== keeper?.path).map((entry) => entry.path);
}

/** Smart selection across every loaded group. */
export function suggestedPaths(
  groups: readonly DuplicateGroup[],
  rule: DuplicateKeeperRule
): string[] {
  return groups.flatMap((group) => suggestedGroupPaths(group, rule));
}

/**
 * Selected entries are resolved against the current groups so a stale path can
 * never authorize a delete, and protected copies are always excluded.
 */
export function selectedDuplicateEntries(
  groups: readonly DuplicateGroup[],
  selected: ReadonlySet<string>
): DuplicateFileEntry[] {
  if (!selected.size) return [];
  return groups
    .flatMap((group) => group.entries)
    .filter((entry) => selected.has(entry.path) && entry.deletePolicy === "cleanable");
}

/**
 * Toggles one copy. Selecting is refused when it would leave the group without
 * any kept copy; protected copies are never selectable.
 */
export function updateEntrySelection(
  selected: ReadonlySet<string>,
  entry: DuplicateFileEntry,
  group: DuplicateGroup,
  nextSelected: boolean
): ReadonlySet<string> {
  if (entry.deletePolicy === "protected") return selected;
  if (nextSelected) {
    const keeperExists = group.entries.some(
      (item) => item.path !== entry.path && !selected.has(item.path)
    );
    if (!keeperExists) return selected;
    if (selected.has(entry.path)) return selected;
    const next = new Set(selected);
    next.add(entry.path);
    return next;
  }
  if (!selected.has(entry.path)) return selected;
  const next = new Set(selected);
  next.delete(entry.path);
  return next;
}

/** Applies the current rule to one group, replacing that group's selection. */
export function selectGroupCopies(
  selected: ReadonlySet<string>,
  group: DuplicateGroup,
  rule: DuplicateKeeperRule
): ReadonlySet<string> {
  const suggested = new Set(suggestedGroupPaths(group, rule));
  const next = new Set(selected);
  for (const entry of group.entries) {
    if (suggested.has(entry.path)) next.add(entry.path);
    else next.delete(entry.path);
  }
  return next;
}

/**
 * Toggles one group's suggested copies. A group whose suggestion is already
 * applied clears its own rows without touching other groups.
 */
export function toggleGroupSelection(
  selected: ReadonlySet<string>,
  group: DuplicateGroup,
  rule: DuplicateKeeperRule
): ReadonlySet<string> {
  const suggested = new Set(suggestedGroupPaths(group, rule));
  const applied = group.entries.every(
    (entry) => selected.has(entry.path) === suggested.has(entry.path)
  );
  if (!applied) return selectGroupCopies(selected, group, rule);
  const next = new Set(selected);
  for (const entry of group.entries) next.delete(entry.path);
  return next;
}

/** Sums physical storage for disk-usage and cleanup estimates. */
export function totalAllocatedBytes(entries: readonly DuplicateFileEntry[]): number {
  return entries.reduce((total, entry) => total + entry.allocatedBytes, 0);
}

/**
 * Appends streamed or paged groups, skipping the hashes already present.
 * Returns the original array when nothing new arrived so React can bail out.
 */
export function mergeDuplicateGroups(
  current: readonly DuplicateGroup[],
  incoming: readonly DuplicateGroup[]
): readonly DuplicateGroup[] {
  if (!incoming.length) return current;
  const known = new Set(current.map((group) => group.hash));
  const next = [...current];
  for (const group of incoming) {
    if (known.has(group.hash)) continue;
    known.add(group.hash);
    next.push(group);
  }
  return next.length === current.length ? current : next;
}

/**
 * Drops deleted entries locally. A group with fewer than two remaining copies
 * is no longer a duplicate group and disappears.
 */
export function removeDuplicatePaths(
  groups: readonly DuplicateGroup[],
  removedPaths: ReadonlySet<string>
): DuplicateGroup[] {
  if (!removedPaths.size) return [...groups];
  const remaining: DuplicateGroup[] = [];
  for (const group of groups) {
    const entries = group.entries.filter((entry) => !removedPaths.has(entry.path));
    if (entries.length < 2) continue;
    const reclaimableBytes = group.entries.some((entry) => entry.deletePolicy === "protected")
      ? totalAllocatedBytes(entries.filter((entry) => entry.deletePolicy === "cleanable"))
      : totalAllocatedBytes(entries) -
        entries.reduce(
          (smallest, entry) => Math.min(smallest, entry.allocatedBytes),
          Number.POSITIVE_INFINITY
        );
    remaining.push({ ...group, entries, reclaimableBytes: Math.max(0, reclaimableBytes) });
  }
  return remaining;
}

// ---------------------------------------------------------------------------
// Labels and presentation helpers
// ---------------------------------------------------------------------------

function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function countBy<T>(items: readonly T[], value: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = value(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Group headings stay readable when several groups share a file name: the
 * parent folder is appended, then a short hash prefix as the last resort.
 * Directory groups are distinguished by their entry paths already.
 */
export function duplicateGroupLabels(
  groups: readonly DuplicateGroup[]
): ReadonlyMap<string, string> {
  const directoryLabels = new Map(
    groups
      .filter((group) => group.kind === "directory")
      .map((group) => [group.id, group.entries[0]?.name ?? ""] as const)
  );
  const fileGroups = groups.filter((group) => group.kind !== "directory");
  const nameCounts = countBy(fileGroups, (group) => group.entries[0]?.name ?? "");
  const baseLabels = new Map(
    groups.map((group) => {
      const entry = group.entries[0];
      const name = entry?.name ?? "";
      if (group.kind === "directory" || (nameCounts.get(name) ?? 0) < 2) {
        return [group.id, name] as const;
      }
      const parentName = entry ? fileName(entry.parentPath) : "";
      return [
        group.id,
        parentName && parentName !== name ? `${name} · ${parentName}` : name,
      ] as const;
    })
  );
  const labelCounts = countBy(fileGroups, (group) => baseLabels.get(group.id) ?? "");
  const pathLabels = new Map(
    groups.map((group) => {
      const entry = group.entries[0];
      const baseLabel = directoryLabels.get(group.id) ?? baseLabels.get(group.id) ?? "";
      if (group.kind === "directory") return [group.id, baseLabel] as const;
      if ((labelCounts.get(baseLabel) ?? 0) < 2 || !entry) return [group.id, baseLabel] as const;
      return [group.id, `${entry.name} · ${entry.parentPath}`] as const;
    })
  );
  const pathLabelCounts = countBy(fileGroups, (group) => pathLabels.get(group.id) ?? "");
  return new Map(
    groups.map((group) => {
      if (group.kind === "directory") {
        return [group.id, directoryLabels.get(group.id) ?? ""] as const;
      }
      const label = pathLabels.get(group.id) ?? "";
      return [
        group.id,
        (pathLabelCounts.get(label) ?? 0) > 1 ? `${label} · ${group.hash.slice(0, 8)}` : label,
      ] as const;
    })
  );
}

/** Case-insensitive comparison key for Windows paths. */
export function duplicatePathKey(path: string): string {
  return path
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/, "")
    .toLocaleLowerCase();
}

export type DuplicateSizeUnit = "kb" | "mb" | "gb";

const SIZE_UNIT_FACTORS: Record<DuplicateSizeUnit, number> = {
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

export const DEFAULT_DUPLICATE_MINIMUM_AMOUNT = 1;
export const DEFAULT_DUPLICATE_MINIMUM_UNIT: DuplicateSizeUnit = "mb";

/** Minimum file size in bytes; invalid or empty input means "no threshold". */
export function duplicateMinimumBytes(amount: number, unit: DuplicateSizeUnit): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * SIZE_UNIT_FACTORS[unit]);
}

/** i18n key for the progress stage; unknown stages read as the scan start. */
export function duplicateScanStageKey(stage: DuplicateScanStage | null): string {
  if (!stage) return "systools.duplicates.scanning.waiting";
  return `systools.duplicates.scanning.stages.${stage}`;
}

/** Progress percentage; the bar pulses while the native step count is unknown. */
export function duplicateProgressPercent(progress: DuplicateScanProgress | null): number {
  if (!progress || progress.totalSteps <= 0) return 0;
  return Math.min(100, Math.round((progress.completedSteps / progress.totalSteps) * 100));
}

const ERROR_KEYS: Record<SystoolsError["code"], string> = {
  invalidInput: "systools.errors.invalidInput",
  operationBusy: "systools.errors.operationBusy",
  operationCancelled: "systools.duplicates.toast.scanCancelled",
  operationFailed: "systools.errors.operationFailed",
  permissionDenied: "systools.errors.permissionDenied",
  persistenceFailed: "systools.errors.persistenceFailed",
  taskJoinFailed: "systools.errors.taskJoinFailed",
  notImplemented: "systools.errors.notImplemented",
};

/** i18n key for a duplicate command rejection. */
export function duplicateErrorKey(error: unknown): string {
  const parsed = parseSystoolsError(error);
  if (!parsed) return "systools.errors.unknown";
  return ERROR_KEYS[parsed.code] ?? "systools.errors.operationFailed";
}

/** Cancellations end the scan without surfacing a failure. */
export function isDuplicateCancellation(error: unknown): boolean {
  const parsed = parseSystoolsError(error);
  return parsed !== null && isCancellationError(parsed);
}
