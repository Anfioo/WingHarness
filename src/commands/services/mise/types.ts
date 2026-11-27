// DTOs and error discrimination for the environment page.
//
// Mirrors `mise-core/src/models.rs` and `mise-core/src/error.rs`. Every field
// is camelCase on the wire; enums keep the casing named below.

export type MiseHealthLevel = "healthy" | "info" | "warning" | "critical";
export type MiseRuntimeSource = "path" | "scoop" | "direct" | "unknown";
export type MiseShimState = "present" | "missing" | "unsupported";
export type MiseSignalCode =
  "runtime" | "active-tools" | "path-export" | "java-home" | "config-source";
export type MiseToolSourceKind = "global" | "project" | "unknown";
export type MiseRemoteState = "pending" | "ready" | "unavailable";
export type MiseImpactReason = "global" | "project";
export type MiseToolActionKind = "upgrade" | "inspect-source" | "show-current";
export type MiseNoticeCode =
  "windows-shim-missing" | "remote-unavailable" | "project-trust" | "other";
export type MiseHistoryStatus = "success" | "failure" | "canceled";
export type MiseOutputSource = "stdout" | "stderr";
export type MiseActionProgressKind =
  "command-started" | "output" | "command-finished" | "lockfile-cleanup";
export type MiseProjectNotes = "overrides" | "project-only" | "none" | "consistent";
export type MiseProjectScanIssue = "not-trusted" | "unavailable";
export type MiseBindingSource = "project" | "project-file" | "global" | "inherited" | "resolved";
export type MiseConfigDocumentKind = "global" | "project";
export type MiseConfigValueType = "string" | "integer" | "boolean";
export type MiseConfigEditKind = "document" | "settings" | "proxy" | "aliases";

export type MiseConfigEdit =
  | { kind: "document"; content: string }
  | { kind: "settings"; values: Record<string, string | null> }
  | { kind: "proxy"; values: Record<string, string | null> }
  | { kind: "aliases"; values: Record<string, string | null> };

export type MiseShimStatus = {
  state: MiseShimState;
  directory: string | null;
  detail: string | null;
};

export type MiseRuntimeInfo = {
  available: boolean;
  executable: string | null;
  version: string | null;
  source: MiseRuntimeSource | null;
  /** A command to paste into a terminal, not prose. */
  installHint: string;
  detail: string | null;
  shims: MiseShimStatus | null;
};

export type MiseEnvironmentSignal = {
  code: MiseSignalCode;
  level: MiseHealthLevel;
  value: string;
  detail: string | null;
};

export type MiseSystemInfo = {
  osName: string | null;
  osVersion: string | null;
  kernelVersion: string | null;
  hostName: string | null;
  arch: string;
  cpuCount: number;
  cpuBrand: string | null;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  diskTotalBytes: number | null;
  diskAvailableBytes: number | null;
  diskMount: string | null;
};

export type MiseToolSummaryCounts = {
  installedToolCount: number;
  activeToolCount: number;
};

export type MiseProjectSummary = {
  projectCount: number;
  declaredToolCount: number;
  overrideProjectCount: number;
  overrideBindingCount: number;
};

export type MiseVersionInfo = {
  version: string | null;
  executable: string | null;
  source: MiseRuntimeSource | null;
};

export type MiseNotice = {
  code: MiseNoticeCode;
  level: MiseHealthLevel;
  detail: string | null;
  command: string | null;
};

export type MiseDashboard = {
  runtime: MiseRuntimeInfo;
  system: MiseSystemInfo;
  toolSummary: MiseToolSummaryCounts;
  projectSummary: MiseProjectSummary;
  versionInfo: MiseVersionInfo;
  signals: MiseEnvironmentSignal[];
  recentHistory: MiseHistoryEntry[];
  notices: MiseNotice[];
};

export type MiseInstalledVersion = {
  version: string;
  requestedVersion: string | null;
  installPath: string | null;
  installed: boolean;
  active: boolean;
  sourceKind: MiseToolSourceKind;
  sourcePath: string | null;
};

export type MiseToolProjectImpact = {
  projectName: string;
  path: string;
  requestedVersion: string;
  resolvedVersion: string;
  reason: MiseImpactReason;
};

export type MiseToolAction = {
  kind: MiseToolActionKind;
  command: string;
  level: MiseHealthLevel;
  version: string | null;
};

export type MiseRemoteVersion = {
  version: string;
  rolling: boolean;
  createdAt: string | null;
};

export type MiseTool = {
  id: string;
  name: string;
  activeVersion: string;
  requestedVersion: string;
  sourceKind: MiseToolSourceKind;
  sourcePath: string | null;
  level: MiseHealthLevel;
  installedVersions: MiseInstalledVersion[];
  projectImpacts: MiseToolProjectImpact[];
  quickActions: MiseToolAction[];
  commandPreview: string;
  updateVersion: string | null;
  latestStableVersion: string | null;
  latestPreviewVersion: string | null;
  remoteVersions: MiseRemoteVersion[];
  remoteState: MiseRemoteState;
  notices: MiseNotice[];
};

export type MiseHistoryEntry = {
  id: string;
  /** Unix milliseconds. */
  timestampMs: number;
  command: string;
  /** English diagnostic text; the UI localizes around it. */
  detail: string;
  level: MiseHealthLevel;
  status: MiseHistoryStatus;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string | null;
  stderr: string | null;
  stdoutSnippet: string | null;
  stderrSnippet: string | null;
};

export type MiseOutputChunk = {
  source: MiseOutputSource;
  text: string;
};

export type MiseExecutedCommand = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export type MiseLockfileReport = {
  removedPaths: string[];
  failedPaths: string[];
  detectedPaths: string[];
};

export type MiseActionResult = {
  script: string;
  commands: MiseExecutedCommand[];
  lockfileCleanup: MiseLockfileReport | null;
};

export type MiseActionProgress = {
  kind: MiseActionProgressKind;
  command: string;
  commandIndex: number;
  totalCommands: number;
  output: string | null;
  outputSource: MiseOutputSource | null;
  exitCode: number | null;
  lockfileCleanup: MiseLockfileReport | null;
};

export type MiseCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export type MiseScanDirectory = {
  path: string;
  enabled: boolean;
};

export type MiseProjectBinding = {
  name: string;
  projectVersion: string;
  globalVersion: string;
  source: MiseBindingSource;
  sourceFile: string | null;
  declaredInProject: boolean;
  declaredInGlobal: boolean;
  overridesGlobal: boolean;
};

export type MiseProject = {
  name: string;
  path: string;
  scanRootPath: string;
  configPath: string;
  configPaths: string[];
  tools: string[];
  lastModifiedMs: number | null;
  commandPreview: string;
  bindings: MiseProjectBinding[];
  level: MiseHealthLevel;
  declaredToolCount: number;
  overrideCount: number;
  projectOnlyToolCount: number;
  notes: MiseProjectNotes;
  scanIssue: MiseProjectScanIssue | null;
};

export type MiseProjectCoverage = {
  openedProjects: string[];
  scanDirectories: MiseScanDirectory[];
  projects: MiseProject[];
  notices: MiseNotice[];
};

export type MiseConfigDocument = {
  kind: MiseConfigDocumentKind;
  path: string;
  content: string;
  exists: boolean;
};

export type MiseConfigProjectRef = {
  path: string;
  name: string;
  configPath: string;
};

export type MiseConfigToolEntry = {
  tool: string;
  version: string;
};

export type MiseConfigToolsSection = {
  kind: MiseConfigDocumentKind;
  entries: MiseConfigToolEntry[];
};

export type MiseConfigRuntimeSetting = {
  key: string;
  valueType: MiseConfigValueType;
  value: string;
  defaultValue: string;
  isSet: boolean;
};

export type MiseConfigRuntimeSettings = {
  path: string;
  settings: MiseConfigRuntimeSetting[];
};

export type MiseConfigProxySetting = {
  key: string;
  value: string;
  placeholder: string;
  isSet: boolean;
  requiresUri: boolean;
};

export type MiseConfigProxySettings = {
  path: string;
  settings: MiseConfigProxySetting[];
};

export type MiseConfigAlias = {
  alias: string;
  target: string;
};

export type MiseConfigWorkspace = {
  documents: MiseConfigDocument[];
  project: MiseConfigProjectRef | null;
  toolsSections: MiseConfigToolsSection[];
  runtimeSettings: MiseConfigRuntimeSettings;
  proxySettings: MiseConfigProxySettings;
  javaAliases: MiseConfigAlias[];
};

export type MiseConfigSavePreview = {
  path: string;
  exists: boolean;
  currentContent: string;
  nextContent: string;
  diff: string;
  hasChanges: boolean;
  createsFile: boolean;
};

export type MiseConfigSaveResult = {
  path: string;
  backupPath: string | null;
  bytesWritten: number;
  created: boolean;
};

/** Stable error codes returned by every `mise_*` command. */
export type MiseErrorCode =
  | "mise-not-found"
  | "not-found"
  | "invalid-input"
  | "unsafe-command"
  | "busy"
  | "timeout"
  | "io"
  | "cancelled"
  | "not-implemented"
  | "internal";

/** Shape of a rejected `mise_*` command. */
export type MiseError = {
  code: MiseErrorCode;
  message: string;
  detail: unknown | null;
};

const MISE_ERROR_CODES = new Set<string>([
  "mise-not-found",
  "not-found",
  "invalid-input",
  "unsafe-command",
  "busy",
  "timeout",
  "io",
  "cancelled",
  "not-implemented",
  "internal",
]);

/** Narrow a rejected command to the engine's error type. */
export function isMiseError(value: unknown): value is MiseError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && MISE_ERROR_CODES.has(code);
}

/** `code` of a rejected command, or `null` when it came from somewhere else. */
export function miseErrorCode(error: unknown): MiseErrorCode | null {
  return isMiseError(error) ? error.code : null;
}
