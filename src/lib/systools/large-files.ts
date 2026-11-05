// Large-file DTOs, command wrappers, and presentation helpers for systools.
//
// The Rust DTOs are camelCase; these types mirror
// `systools-core/src/storage/large_files/models.rs` one-to-one so the page never
// has to work with an opaque payload.

import {
  systoolsFilterDirectoryPaths,
  systoolsLargeFilesCancel,
  systoolsLargeFilesDelete,
  systoolsLargeFilesFilter,
  systoolsLargeFilesScan,
  systoolsPrefsGet,
  systoolsRevealInFileManager,
  systoolsSystemDisk,
  systoolsVolumesList,
} from "@/commands/services/systools";
import { openPath } from "@/commands";
import type { SystoolsPrefs } from "@/commands/services/systools/types";
import { isCancellationError, parseSystoolsError } from "@/lib/systools/applications";

/** Native event emitted while a large-file scan runs. */
export const LARGE_FILES_PROGRESS_EVENT = "systools:large-files-progress";

/**
 * Every scan retains candidates from this floor, and the native side clamps a
 * lower threshold up to it, so the UI clamps first and never asks for less.
 */
export const LARGE_FILE_MINIMUM_FLOOR_BYTES = 50 * 1024 * 1024;

/** Matches the reference default of 100 MB. */
export const LARGE_FILE_DEFAULT_MINIMUM_BYTES = 100 * 1024 * 1024;

/** Complete mode is authoritative for reachable files and is the safe default. */
export const LARGE_FILE_DEFAULT_SCAN_MODE: LargeFileScanMode = "complete";

/** Fixed row height keeps the virtualized list cheap to scroll. */
export const LARGE_FILE_ROW_HEIGHT = 36;

export type LargeFileScanMode = "quick" | "complete";

export type MinimumSizeUnit = "mb" | "gb";

export interface LargeFileEntry {
  name: string;
  path: string;
  parentPath: string;
  bytes: number;
  modifiedAtMs: number | null;
}

export interface LargeFilesResult {
  scanId: number;
  roots: string[];
  scannedAtMs: number;
  scanMode: LargeFileScanMode;
  minimumBytes: number;
  totalBytes: number;
  totalCount: number;
  returnedCount: number;
  truncated: boolean;
  skippedCount: number;
  entries: LargeFileEntry[];
}

export interface VolumeInfo {
  name: string;
  mountPoint: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
}

export interface ResolvedDirectory {
  requestedPath: string;
  path: string;
}

export interface DirectorySelectionOutcome {
  schemaVersion: number;
  directories: ResolvedDirectory[];
  rejectedCount: number;
  redirectedCount: number;
}

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

export interface PermanentDeleteFailure {
  path: string;
  message: string;
  reason: PermanentDeleteFailureReason;
  stage: PermanentDeleteFailureStage;
  nativeCode: number | null;
  partial: boolean;
  remainingRestored: boolean;
}

export interface PermanentDeleteBatchResult {
  removedPaths: string[];
  alreadyAbsentPaths?: string[];
  failed: PermanentDeleteFailure[];
  releasedBytesIsEstimate?: boolean;
  releasedBytes: number;
}

/**
 * Payload of `systools:large-files-progress`.
 *
 * The native producer reports `TraversalProgress`; fields stay optional so a
 * partial event never breaks rendering.
 */
export interface LargeFilesProgress {
  operationId?: number;
  currentStage?: string;
  currentPath?: string;
  itemsScanned?: number;
  bytesScanned?: number;
  completedSteps?: number;
  totalSteps?: number;
  foundItems?: number;
  foundBytes?: number;
  elapsedMs?: number;
}

/**
 * The frozen command wrapper types `scanId` as a string, but the native
 * commands take `u64` and Tauri deserializes arguments strictly. Session ids
 * are small integers, so the number is forwarded unchanged.
 */
export function largeFileScanIdArg(scanId: number): string {
  return scanId as unknown as string;
}

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/** Scan the given roots; the shared scan exclusions come from persisted prefs. */
export async function scanLargeFiles(
  roots: string[],
  minimumBytes: number,
  scanMode: LargeFileScanMode,
  exclusions: SystoolsPrefs
): Promise<LargeFilesResult> {
  return (await systoolsLargeFilesScan(
    roots,
    minimumBytes,
    scanMode,
    exclusions.excludedPaths,
    exclusions.excludedNames
  )) as unknown as LargeFilesResult;
}

/** Persisted scan exclusions shared by every systools tool. */
export async function loadLargeFilePrefs(): Promise<SystoolsPrefs> {
  const prefs = await systoolsPrefsGet();
  return {
    excludedPaths: Array.isArray(prefs.excludedPaths) ? prefs.excludedPaths : [],
    excludedNames: Array.isArray(prefs.excludedNames) ? prefs.excludedNames : [],
  };
}

/** Re-filter the retained scan snapshot by a new size threshold. */
export async function filterLargeFiles(
  scanId: number,
  minimumBytes: number
): Promise<LargeFilesResult> {
  return (await systoolsLargeFilesFilter(
    largeFileScanIdArg(scanId),
    minimumBytes
  )) as unknown as LargeFilesResult;
}

/** Stop an in-flight scan; the previous result stays on screen. */
export async function cancelLargeFilesScan(): Promise<void> {
  await systoolsLargeFilesCancel();
}

/** Permanently delete the selected paths. */
export async function deleteLargeFiles(
  scanId: number,
  selectedPaths: string[]
): Promise<PermanentDeleteBatchResult> {
  return (await systoolsLargeFilesDelete(
    largeFileScanIdArg(scanId),
    selectedPaths
  )) as unknown as PermanentDeleteBatchResult;
}

/** Reveals one entry in File Explorer. */
export async function revealLargeFile(path: string): Promise<void> {
  await systoolsRevealInFileManager(path);
}

/** Opens one entry with its registered default handler. */
export async function openLargeFile(path: string): Promise<void> {
  await openPath(path);
}

/** Keep only the entries that resolve to existing directories. */
export async function resolveExistingDirectories(paths: string[]): Promise<string[]> {
  const outcome = (await systoolsFilterDirectoryPaths(
    paths
  )) as unknown as DirectorySelectionOutcome;
  return outcome.directories.map((entry) => entry.path);
}

/** Mounted volumes used to offer drive roots. */
export async function listVolumes(refresh = false): Promise<VolumeInfo[]> {
  return (await systoolsVolumesList(refresh)) as unknown as VolumeInfo[];
}

/** The volume that hosts Windows, used as the initial root. */
export async function systemDisk(): Promise<VolumeInfo> {
  return (await systoolsSystemDisk()) as unknown as VolumeInfo;
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure and unit-friendly)
// ---------------------------------------------------------------------------

export type LargeFileSortKey = "size" | "name" | "modified";
export type LargeFileSortDirection = "asc" | "desc";

function compareNames(left: LargeFileEntry, right: LargeFileEntry): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

/** Copy and sort without mutating the caller's array. */
export function sortLargeFiles(
  entries: readonly LargeFileEntry[],
  key: LargeFileSortKey,
  direction: LargeFileSortDirection
): LargeFileEntry[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    let comparison = 0;
    if (key === "name") {
      comparison = compareNames(left, right) * sign;
    } else if (key === "modified") {
      // Unknown timestamps sort last in either direction.
      if (left.modifiedAtMs === null && right.modifiedAtMs === null) comparison = 0;
      else if (left.modifiedAtMs === null) return 1;
      else if (right.modifiedAtMs === null) return -1;
      else comparison = (left.modifiedAtMs - right.modifiedAtMs) * sign;
    } else {
      comparison = (left.bytes - right.bytes) * sign;
    }
    return comparison || compareNames(left, right);
  });
}

export interface LargeFileSelectionSummary {
  count: number;
  bytes: number;
  /** Every visible entry is selected. */
  allSelected: boolean;
  /** Some, but not all, visible entries are selected. */
  partiallySelected: boolean;
}

/** Selection totals across the rows currently on screen. */
export function selectionSummary(
  entries: readonly LargeFileEntry[],
  selectedPaths: ReadonlySet<string>
): LargeFileSelectionSummary {
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!selectedPaths.has(entry.path)) continue;
    count += 1;
    bytes += entry.bytes;
  }
  return {
    count,
    bytes,
    allSelected: entries.length > 0 && count === entries.length,
    partiallySelected: count > 0 && count < entries.length,
  };
}

/** Entries in list order that the given paths select. */
export function selectedLargeFiles(
  entries: readonly LargeFileEntry[],
  selectedPaths: ReadonlySet<string>
): LargeFileEntry[] {
  return entries.filter((entry) => selectedPaths.has(entry.path));
}

/** Immutable selection update for one or more paths. */
export function setLargeFilesSelected(
  selectedPaths: ReadonlySet<string>,
  paths: readonly string[],
  selected: boolean
): ReadonlySet<string> {
  const next = new Set(selectedPaths);
  for (const path of paths) {
    if (selected) next.add(path);
    else next.delete(path);
  }
  return next;
}

/** Drops selected paths that a new result no longer contains. */
export function pruneLargeFileSelection(
  selectedPaths: ReadonlySet<string>,
  next: Pick<LargeFilesResult, "entries">
): ReadonlySet<string> {
  if (selectedPaths.size === 0) return selectedPaths;
  const present = new Set(next.entries.map((entry) => entry.path));
  const kept = new Set<string>();
  for (const path of selectedPaths) {
    if (present.has(path)) kept.add(path);
  }
  return kept.size === selectedPaths.size ? selectedPaths : kept;
}

/**
 * Drops deleted rows from a scan result after a permanent delete.
 *
 * Threshold filtering stays server-side; this only reconciles a completed
 * delete so a row that no longer exists cannot be shown again.
 */
export function removeLargeFilePaths(
  result: LargeFilesResult,
  removedPaths: ReadonlySet<string>
): LargeFilesResult {
  let removedBytes = 0;
  const entries: LargeFileEntry[] = [];
  for (const entry of result.entries) {
    if (removedPaths.has(entry.path)) {
      removedBytes += entry.bytes;
    } else {
      entries.push(entry);
    }
  }
  const totalCount = Math.max(0, result.totalCount - removedPaths.size);
  return {
    ...result,
    totalBytes: Math.max(0, result.totalBytes - removedBytes),
    totalCount,
    returnedCount: entries.length,
    truncated: entries.length < totalCount,
    entries,
  };
}

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * 1024 * 1024;

/** Converts the size input into a threshold the native floor accepts. */
export function minimumSizeBytes(amount: number, unit: MinimumSizeUnit): number {
  const factor = unit === "gb" ? GIGABYTE : MEGABYTE;
  if (!Number.isFinite(amount) || amount <= 0) return LARGE_FILE_MINIMUM_FLOOR_BYTES;
  return Math.max(LARGE_FILE_MINIMUM_FLOOR_BYTES, Math.round(amount * factor));
}

/** Case-insensitive path comparison key for de-duplicating roots. */
function pathKey(path: string): string {
  return path.replace(/[\\/]+$/, "").toLocaleLowerCase();
}

/** De-duplicates roots while keeping the first spelling the user chose. */
export function uniqueRoots(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const key = pathKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(trimmed);
  }
  return roots;
}

/** i18n key for a command rejection, using the shared systools error copy. */
export function largeFilesErrorKey(error: unknown): string {
  const parsed = parseSystoolsError(error);
  if (!parsed) return "systools.errors.unknown";
  if (isCancellationError(parsed)) return "systools.errors.operationCancelled";
  return `systools.errors.${parsed.code}`;
}

/** Whether a rejection means the user stopped the scan. */
export function isLargeFilesCancellation(error: unknown): boolean {
  const parsed = parseSystoolsError(error);
  return parsed !== null && isCancellationError(parsed);
}
