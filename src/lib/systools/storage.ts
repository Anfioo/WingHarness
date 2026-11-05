import { invokeCommand } from "@/commands/base";
import { isCancellationError, parseSystoolsError } from "@/lib/systools/applications";

// ---------------------------------------------------------------------------
// Native contract
// ---------------------------------------------------------------------------

/** Event emitted while a directory scan runs. */
export const ANALYSIS_PROGRESS_EVENT = "systools:analysis-progress";

/** Direct children the native result projects per directory before truncation. */
export const ANALYSIS_VISIBLE_ENTRY_LIMIT = 500;

export const ANALYSIS_CHART_MAX_DEPTH = 6;
export const ANALYSIS_REMAINDER_SCHEMA_VERSION = 2;

export const ANALYSIS_SCAN_MODES = ["standard", "fast"] as const;
export type AnalysisScanMode = (typeof ANALYSIS_SCAN_MODES)[number];

export const ANALYSIS_VIEW_IDS = ["treemap", "sunburst"] as const;
export type AnalysisViewId = (typeof ANALYSIS_VIEW_IDS)[number];

export const ANALYSIS_DEFAULT_TREEMAP_DEPTH = 2;
export const ANALYSIS_DEFAULT_SUNBURST_DEPTH = 3;
export const ANALYSIS_ROW_HEIGHT = 36;

export const ANALYSIS_ENTRY_SIZE_STATUSES = ["complete", "partial", "unavailable"] as const;
export type EntrySizeStatus = (typeof ANALYSIS_ENTRY_SIZE_STATUSES)[number];

export const ANALYSIS_DELETION_PROTECTIONS = ["systemManagedFile", "protectedPath"] as const;
export type DeletionProtection = (typeof ANALYSIS_DELETION_PROTECTIONS)[number];

export const ANALYSIS_OMISSION_KEYS = [
  "permissionDenied",
  "readErrors",
  "excluded",
  "linkOrMount",
  "other",
] as const;
export type AnalysisOmissionKey = (typeof ANALYSIS_OMISSION_KEYS)[number];

/** Omission categories stay opaque to the UI; unknown keys are still counted. */
export type AnalysisOmissions = Partial<Record<AnalysisOmissionKey, number>> & {
  [key: string]: number | undefined;
};

export interface AnalysisCoverage {
  schemaVersion: number;
  omissions: AnalysisOmissions;
  elevated: boolean | null;
}

export interface DirectoryEntryInfo {
  sizeStatus?: EntrySizeStatus;
  name: string;
  path: string;
  bytes: number;
  fileCount: number;
  isDirectory: boolean;
  modifiedAtMs: number | null;
  contentFingerprint: string | null;
  /** Older cached results omit the hint; native deletion still checks protection. */
  deletionProtection?: DeletionProtection | null;
}

export interface AnalysisDirectoryNode {
  name: string;
  path: string;
  bytes: number;
  fileCount: number;
  /** Positive-byte direct children before the bounded projection. */
  totalEntryCount?: number;
  children: AnalysisDirectoryNode[];
  files?: DirectoryEntryInfo[];
}

export interface AnalysisResult {
  policyVersion?: number;
  coverage?: AnalysisCoverage;
  scanMode?: AnalysisScanMode;
  scanId: number;
  root: string;
  scannedAtMs: number;
  totalBytes: number;
  totalEntryCount?: number;
  skippedCount: number;
  truncated: boolean;
  entries: DirectoryEntryInfo[];
  directoryHierarchy?: AnalysisDirectoryNode[];
}

export interface AnalysisRemainderSelection {
  parentPath: string;
  bytes: number;
  visiblePaths: string[];
}

export interface AnalysisRemainderRequest {
  schemaVersion: typeof ANALYSIS_REMAINDER_SCHEMA_VERSION;
  scanId: number;
  parentPath: string;
  visiblePaths: string[];
  expectedBytes: number;
  offset: number;
  snapshotId: number | null;
}

export interface AnalysisRemainderPage {
  snapshotId: number;
  schemaVersion: number;
  parentPath: string;
  totalBytes: number;
  totalCount: number;
  entries: DirectoryEntryInfo[];
  nextOffset: number | null;
}

export const ANALYSIS_EXPORT_DEPTHS = [1, 2, 3, 4, 5, 6] as const;
export type AnalysisExportDepth = (typeof ANALYSIS_EXPORT_DEPTHS)[number];

/** Zero means "every cached entry within the selected depth". */
export const ANALYSIS_EXPORT_ENTRY_LIMITS = [0, 200, 500, 1000, 2000] as const;
export type AnalysisExportEntryLimit = (typeof ANALYSIS_EXPORT_ENTRY_LIMITS)[number];

export const ANALYSIS_EXPORT_FORMATS = ["json", "markdown"] as const;
export type AnalysisExportFormat = (typeof ANALYSIS_EXPORT_FORMATS)[number];

export interface AnalysisExportRequest {
  scanId: number;
  /** Absolute destination chosen in the save dialog. */
  path: string;
  maxDepth: AnalysisExportDepth;
  maxEntries: AnalysisExportEntryLimit;
  includeFullPaths: boolean;
  format: AnalysisExportFormat;
}

export interface AnalysisExportReceipt {
  schemaVersion: number;
  path: string;
  entryCount: number;
  fileBytes: number;
}

export interface AnalysisDeleteFailure {
  path: string;
  reason: string | null;
}

export interface AnalysisDeleteBatchResult {
  schemaVersion: number;
  removedPaths: string[];
  failed: AnalysisDeleteFailure[];
  notAttemptedPaths: string[];
  requiresRescan: boolean;
  releasedBytes: number;
  /** Authoritative snapshots reconciled without starting another scan. */
  updatedResults: AnalysisResult[];
  invalidatedScanIds: number[];
}

export interface ScanNameExclusion {
  name: string;
  kind: "file" | "folder";
}

export interface AnalysisProgress {
  operationId: number;
  currentStage: string;
  currentPath: string;
  itemsScanned: number;
  bytesScanned: number;
  completedSteps: number;
  totalSteps: number;
  foundItems: number;
  foundBytes: number;
  elapsedMs: number;
}

type ScanAnalysisParams = {
  path: string | null;
  refresh: boolean;
  excludedPaths: string[];
  excludedNames: ScanNameExclusion[];
  scanMode: AnalysisScanMode;
};

// ---------------------------------------------------------------------------
// Command wrappers
//
// The shared systools service types scan and snapshot identifiers as strings,
// while the native commands take `u64`. These wrappers keep the numeric shape
// the backend actually expects.
// ---------------------------------------------------------------------------

export function scanAnalysis(
  path: string | null,
  refresh: boolean,
  scanMode: AnalysisScanMode,
  excludedPaths: string[] = [],
  excludedNames: ScanNameExclusion[] = []
): Promise<AnalysisResult> {
  const trimmed = path?.trim() ?? "";
  return invokeCommand<ScanAnalysisParams, AnalysisResult>("systools_analysis_scan", {
    path: trimmed ? trimmed : null,
    refresh,
    excludedPaths,
    excludedNames,
    scanMode,
  });
}

export function cancelAnalysis(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("systools_analysis_cancel", {});
}

export function listAnalysisRemainder(
  request: AnalysisRemainderRequest
): Promise<AnalysisRemainderPage> {
  return invokeCommand<{ request: AnalysisRemainderRequest }, AnalysisRemainderPage>(
    "systools_analysis_remainder_list",
    { request }
  );
}

export function releaseAnalysisRemainder(snapshotId: number): Promise<void> {
  return invokeCommand<{ snapshotId: number }, void>("systools_analysis_remainder_release", {
    snapshotId,
  });
}

export function exportAnalysis(
  request: AnalysisExportRequest,
  dialogTitle: string
): Promise<AnalysisExportReceipt | null> {
  return invokeCommand<
    { request: AnalysisExportRequest; dialogTitle: string },
    AnalysisExportReceipt | null
  >("systools_analysis_export", { request, dialogTitle });
}

export function deleteAnalysisEntries(
  scanId: number,
  selectedPaths: string[]
): Promise<AnalysisDeleteBatchResult> {
  return invokeCommand<{ scanId: number; selectedPaths: string[] }, AnalysisDeleteBatchResult>(
    "systools_analysis_delete_entries",
    { scanId, selectedPaths }
  );
}

export function openAnalysisEntry(scanId: number, selectedPath: string): Promise<void> {
  return invokeCommand<{ scanId: number; selectedPath: string }, void>(
    "systools_open_analysis_entry",
    { scanId, selectedPath }
  );
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Comparison key: separator- and case-insensitive Windows path. */
export function normalizePathKey(path: string): string {
  let normalized = path.replace(/\//g, "\\");
  while (normalized.length > 3 && normalized.endsWith("\\")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLocaleLowerCase();
}

export function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

function splitPath(path: string): string[] {
  return path
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .split("\\")
    .filter((segment) => segment.length > 0);
}

function joinPathSegments(segments: string[]): string {
  const joined = segments.join("\\");
  return /^[A-Za-z]:$/.test(joined) ? `${joined}\\` : joined;
}

/** Last path segment, keeping drive roots readable as `C:\`. */
export function pathName(path: string): string {
  const segments = splitPath(path);
  if (segments.length === 0) return path;
  if (segments.length === 1 && /^[A-Za-z]:$/.test(segments[0])) return `${segments[0]}\\`;
  return segments[segments.length - 1];
}

/** True when `child` is `parent` or lives below it. */
export function isPathInside(parent: string, child: string): boolean {
  const parentKey = normalizePathKey(parent);
  const childKey = normalizePathKey(child);
  if (parentKey === childKey) return true;
  const prefix = parentKey.endsWith("\\") ? parentKey : `${parentKey}\\`;
  return childKey.startsWith(prefix);
}

export interface AnalysisBreadcrumb {
  name: string;
  path: string;
}

/** Root-relative breadcrumbs; falls back to the current path's own segments. */
export function analysisBreadcrumbs(root: string, current: string): AnalysisBreadcrumb[] {
  const rootSegments = splitPath(root);
  const currentSegments = splitPath(current);

  if (!isPathInside(root, current)) {
    return currentSegments.map((segment, index) => ({
      name: segment,
      path: joinPathSegments(currentSegments.slice(0, index + 1)),
    }));
  }

  const breadcrumbs: AnalysisBreadcrumb[] = [
    {
      name: pathName(joinPathSegments(rootSegments)),
      path: joinPathSegments(rootSegments),
    },
  ];
  for (let index = rootSegments.length; index < currentSegments.length; index += 1) {
    breadcrumbs.push({
      name: currentSegments[index],
      path: joinPathSegments(currentSegments.slice(0, index + 1)),
    });
  }
  return breadcrumbs;
}

/** Parent directory of a normalized path, or null at a drive root. */
export function parentPath(path: string): string | null {
  const segments = splitPath(path);
  if (segments.length <= 1) return null;
  return joinPathSegments(segments.slice(0, -1));
}

// ---------------------------------------------------------------------------
// Result projections
// ---------------------------------------------------------------------------

/** Projects a hierarchy directory into the entry shape used by charts and lists. */
export function directoryNodeEntry(node: AnalysisDirectoryNode): DirectoryEntryInfo {
  return {
    sizeStatus: "complete",
    name: node.name,
    path: node.path,
    bytes: node.bytes,
    fileCount: node.fileCount,
    isDirectory: true,
    modifiedAtMs: null,
    contentFingerprint: null,
    deletionProtection: null,
  };
}

/** Index of every projected directory, keyed by comparison path. */
export function buildHierarchyIndex(result: AnalysisResult): Map<string, AnalysisDirectoryNode> {
  const index = new Map<string, AnalysisDirectoryNode>();
  const visit = (node: AnalysisDirectoryNode) => {
    index.set(normalizePathKey(node.path), node);
    for (const child of node.children) visit(child);
  };
  for (const node of result.directoryHierarchy ?? []) visit(node);
  return index;
}

export function findDirectoryNode(
  result: AnalysisResult,
  path: string
): AnalysisDirectoryNode | null {
  const key = normalizePathKey(path);
  const visit = (node: AnalysisDirectoryNode): AnalysisDirectoryNode | null => {
    if (normalizePathKey(node.path) === key) return node;
    for (const child of node.children) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  for (const node of result.directoryHierarchy ?? []) {
    const match = visit(node);
    if (match) return match;
  }
  return null;
}

/** Direct children of one projected directory. */
export interface AnalysisDirectoryListing {
  path: string;
  name: string;
  bytes: number;
  fileCount: number;
  entries: DirectoryEntryInfo[];
  totalEntryCount: number;
  /** True when the native projection omitted direct children. */
  truncated: boolean;
  /** True when this listing was reconstructed from the bounded hierarchy. */
  fromHierarchy: boolean;
}

/** Builds the listing for the scan root or any projected hierarchy directory. */
export function directoryListing(
  result: AnalysisResult,
  path: string
): AnalysisDirectoryListing | null {
  if (samePath(path, result.root)) {
    return {
      path: result.root,
      name: pathName(result.root),
      bytes: result.totalBytes,
      fileCount: result.entries.reduce((total, entry) => total + entry.fileCount, 0),
      entries: result.entries,
      totalEntryCount: result.totalEntryCount ?? result.entries.length,
      truncated: result.truncated,
      fromHierarchy: false,
    };
  }

  const node = findDirectoryNode(result, path);
  if (!node) return null;
  const entries = [...node.children.map(directoryNodeEntry), ...(node.files ?? [])];
  const totalEntryCount = node.totalEntryCount ?? entries.length;
  return {
    path: node.path,
    name: node.name,
    bytes: node.bytes,
    fileCount: node.fileCount,
    entries,
    totalEntryCount,
    truncated: entries.length < totalEntryCount,
    fromHierarchy: true,
  };
}

/** True when the chart can drill into this directory without a rescan. */
export function canDrillInto(result: AnalysisResult | null, entry: DirectoryEntryInfo): boolean {
  if (!entry.isDirectory || !result) return false;
  return findDirectoryNode(result, entry.path) !== null;
}

// ---------------------------------------------------------------------------
// Sorting and selection
// ---------------------------------------------------------------------------

export const ANALYSIS_SORT_KEYS = ["name", "bytes", "fileCount", "modified"] as const;
export type AnalysisSortKey = (typeof ANALYSIS_SORT_KEYS)[number];
export type AnalysisSortDirection = "asc" | "desc";

function compareNames(left: DirectoryEntryInfo, right: DirectoryEntryInfo): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

/** Stable sort with directories interleaved; null timestamps sort last. */
export function sortAnalysisEntries(
  entries: readonly DirectoryEntryInfo[],
  key: AnalysisSortKey,
  direction: AnalysisSortDirection
): DirectoryEntryInfo[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    let comparison: number;
    switch (key) {
      case "bytes":
        comparison = left.bytes - right.bytes;
        break;
      case "fileCount":
        comparison = left.fileCount - right.fileCount;
        break;
      case "modified": {
        const leftTime = left.modifiedAtMs ?? -1;
        const rightTime = right.modifiedAtMs ?? -1;
        comparison = leftTime - rightTime;
        break;
      }
      default:
        comparison = compareNames(left, right);
        break;
    }
    return comparison * sign || compareNames(left, right);
  });
}

export interface AnalysisSelectionSummary {
  count: number;
  bytes: number;
  files: number;
  directories: number;
  protectedCount: number;
}

export function summarizeAnalysisSelection(
  entries: readonly DirectoryEntryInfo[],
  selectedPaths: ReadonlySet<string>
): AnalysisSelectionSummary {
  const summary: AnalysisSelectionSummary = {
    count: 0,
    bytes: 0,
    files: 0,
    directories: 0,
    protectedCount: 0,
  };
  for (const entry of entries) {
    if (!selectedPaths.has(entry.path)) continue;
    summary.count += 1;
    summary.bytes += entry.bytes;
    if (entry.isDirectory) summary.directories += 1;
    else summary.files += 1;
    if (entry.deletionProtection) summary.protectedCount += 1;
  }
  return summary;
}

export function isProtectedEntry(entry: DirectoryEntryInfo): boolean {
  return Boolean(entry.deletionProtection);
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export function omissionCount(
  coverage: AnalysisCoverage | undefined,
  key: AnalysisOmissionKey
): number {
  const value = coverage?.omissions[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Total entries omitted from the scan, including unclassified skips. */
export function totalOmissions(
  coverage: AnalysisCoverage | undefined,
  skippedCount: number
): number {
  if (!coverage) return Math.max(0, skippedCount);
  return Object.values(coverage.omissions).reduce<number>(
    (total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0
  );
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Fixed color families for common extensions. Values index the theme's
 * `--graph-0..9` variables, which stay legible in both themes.
 */
const EXTENSION_COLORS: Readonly<Record<string, number>> = {
  jpg: 0,
  jpeg: 0,
  png: 0,
  gif: 0,
  webp: 0,
  bmp: 0,
  svg: 0,
  ico: 0,
  tif: 0,
  tiff: 0,
  heic: 0,
  avif: 0,
  raw: 0,
  psd: 0,
  mp4: 1,
  mkv: 1,
  avi: 1,
  mov: 1,
  wmv: 1,
  webm: 1,
  flv: 1,
  m4v: 1,
  mpg: 1,
  mpeg: 1,
  mp3: 2,
  wav: 2,
  flac: 2,
  aac: 2,
  ogg: 2,
  m4a: 2,
  wma: 2,
  opus: 2,
  aiff: 2,
  zip: 3,
  rar: 3,
  "7z": 3,
  tar: 3,
  gz: 3,
  tgz: 3,
  xz: 3,
  bz2: 3,
  iso: 3,
  cab: 3,
  pdf: 4,
  doc: 4,
  docx: 4,
  xls: 4,
  xlsx: 4,
  ppt: 4,
  pptx: 4,
  txt: 4,
  md: 4,
  csv: 4,
  json: 4,
  xml: 4,
  yaml: 4,
  yml: 4,
  rtf: 4,
  epub: 4,
  ts: 5,
  tsx: 5,
  js: 5,
  jsx: 5,
  mjs: 5,
  cjs: 5,
  rs: 5,
  py: 5,
  java: 5,
  kt: 5,
  c: 5,
  h: 5,
  cpp: 5,
  hpp: 5,
  cs: 5,
  go: 5,
  rb: 5,
  php: 5,
  swift: 5,
  lua: 5,
  html: 5,
  css: 5,
  scss: 5,
  less: 5,
  sql: 5,
  sh: 5,
  ps1: 5,
  bat: 5,
  vue: 5,
  svelte: 5,
  exe: 6,
  dll: 6,
  msi: 6,
  bin: 6,
  sys: 6,
  so: 6,
  dylib: 6,
  lib: 6,
  obj: 6,
  apk: 6,
  db: 7,
  sqlite: 7,
  sqlite3: 7,
  mdb: 7,
  dat: 7,
  idx: 7,
  ttf: 8,
  otf: 8,
  woff: 8,
  woff2: 8,
  eot: 8,
  tmp: 9,
  temp: 9,
  log: 9,
  cache: 9,
  bak: 9,
  old: 9,
  swp: 9,
};

/** Extension in lower case without the leading dot; empty for extensionless names. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const extension = name.slice(dot + 1).toLocaleLowerCase();
  return extension.length > 12 ? "" : extension;
}

/** Deterministic palette index for a file name. */
export function extensionColorIndex(name: string): number {
  const extension = fileExtension(name);
  if (!extension) return 9;
  const known = EXTENSION_COLORS[extension];
  if (known !== undefined) return known;
  let hash = 0;
  for (let index = 0; index < extension.length; index += 1) {
    hash = (hash * 31 + extension.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 10;
}

/** CSS color for a palette index, resolved through theme variables. */
export function chartColor(index: number): string {
  const bounded = ((Math.trunc(index) % 10) + 10) % 10;
  return `hsl(var(--graph-${bounded}))`;
}

/**
 * Folders are containers rather than file types, so they stay neutral; files
 * use the extension palette.
 */
export function entryChartColor(entry: DirectoryEntryInfo): string {
  return entry.isDirectory
    ? "var(--muted-foreground)"
    : chartColor(extensionColorIndex(entry.name));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function pruneNode(
  node: AnalysisDirectoryNode,
  removed: ReadonlySet<string>
): {
  node: AnalysisDirectoryNode | null;
  removedBytes: number;
  removedFiles: number;
} {
  if (removed.has(normalizePathKey(node.path))) {
    return { node: null, removedBytes: node.bytes, removedFiles: node.fileCount };
  }

  const originalChildren = node.children.length;
  const originalFiles = node.files?.length ?? 0;
  let removedBytes = 0;
  let removedFiles = 0;

  const children: AnalysisDirectoryNode[] = [];
  for (const child of node.children) {
    const pruned = pruneNode(child, removed);
    removedBytes += pruned.removedBytes;
    removedFiles += pruned.removedFiles;
    if (pruned.node) children.push(pruned.node);
  }

  const files: DirectoryEntryInfo[] = [];
  for (const file of node.files ?? []) {
    if (removed.has(normalizePathKey(file.path))) {
      removedBytes += file.bytes;
      removedFiles += 1;
    } else {
      files.push(file);
    }
  }

  const removedDirect = originalChildren - children.length + (originalFiles - files.length);
  return {
    node: {
      ...node,
      bytes: Math.max(0, node.bytes - removedBytes),
      fileCount: Math.max(0, node.fileCount - removedFiles),
      totalEntryCount: Math.max(
        0,
        (node.totalEntryCount ?? originalChildren + originalFiles) - removedDirect
      ),
      children,
      files,
    },
    removedBytes,
    removedFiles,
  };
}

/**
 * Locally drops removed paths when the native result did not include a
 * reconciled snapshot. Byte totals follow the scan metric, not live usage.
 */
export function pruneAnalysisResult(
  result: AnalysisResult,
  removedPaths: readonly string[]
): AnalysisResult {
  if (removedPaths.length === 0) return result;
  const removed = new Set(removedPaths.map(normalizePathKey));

  let removedBytes = 0;
  const entries: DirectoryEntryInfo[] = [];
  for (const entry of result.entries) {
    if (removed.has(normalizePathKey(entry.path))) {
      removedBytes += entry.bytes;
    } else {
      entries.push(entry);
    }
  }
  const removedDirectEntries = result.entries.length - entries.length;

  let nestedBytes = 0;
  const hierarchy: AnalysisDirectoryNode[] = [];
  for (const node of result.directoryHierarchy ?? []) {
    if (removed.has(normalizePathKey(node.path))) continue;
    const pruned = pruneNode(node, removed);
    nestedBytes += pruned.removedBytes;
    if (pruned.node) hierarchy.push(pruned.node);
  }

  return {
    ...result,
    totalBytes: Math.max(0, result.totalBytes - removedBytes - nestedBytes),
    totalEntryCount: Math.max(
      0,
      (result.totalEntryCount ?? result.entries.length) - removedDirectEntries
    ),
    entries,
    directoryHierarchy: hierarchy,
  };
}

/** Reconciled snapshot for the displayed scan, if the mutation returned one. */
export function reconciledAnalysisResult(
  result: AnalysisResult,
  updatedResults: readonly AnalysisResult[]
): AnalysisResult | null {
  const byScanId = updatedResults.find((candidate) => candidate.scanId === result.scanId);
  if (byScanId) return byScanId;
  return updatedResults.find((candidate) => samePath(candidate.root, result.root)) ?? null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ANALYSIS_ERROR_KEYS: Readonly<Record<string, string>> = {
  invalidInput: "systools.analysis.errors.invalidInput",
  operationBusy: "systools.analysis.errors.busy",
  operationCancelled: "systools.analysis.errors.cancelled",
  operationFailed: "systools.analysis.errors.operationFailed",
  permissionDenied: "systools.analysis.errors.permissionDenied",
  persistenceFailed: "systools.analysis.errors.persistenceFailed",
  taskJoinFailed: "systools.analysis.errors.operationFailed",
  notImplemented: "systools.analysis.errors.notImplemented",
};

export function isAnalysisCancellation(error: unknown): boolean {
  const parsed = parseSystoolsError(error);
  if (parsed) return isCancellationError(parsed);
  return error instanceof Error && /cancel/i.test(error.message);
}

export function analysisErrorKey(error: unknown): string {
  const parsed = parseSystoolsError(error);
  if (!parsed) return "systools.analysis.errors.unknown";
  if (isCancellationError(parsed)) return "systools.analysis.errors.cancelled";
  return ANALYSIS_ERROR_KEYS[parsed.code] ?? "systools.analysis.errors.unknown";
}

/** Human-readable native detail when one was provided; never localized here. */
export function analysisErrorDetail(error: unknown): string | null {
  const parsed = parseSystoolsError(error);
  const details = parsed?.details ?? {};
  for (const value of Object.values(details)) {
    if (typeof value === "string" && value.trim()) return value;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return null;
}

/** i18n key for a native deletion-failure reason code, when it is known. */
export function analysisFailureReasonKey(reason: string | null): string | null {
  if (!reason) return null;
  const key = ANALYSIS_ERROR_KEYS[reason];
  return key ?? null;
}
