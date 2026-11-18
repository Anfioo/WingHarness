// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Stable identities for the process tab.
//
// A process instance is its PID plus its creation time: Windows reuses PIDs,
// so acting on the PID alone could target a different process than the one the
// user selected. Application groups derive their key from the image path (or
// the WebView2 runtime) rather than from the executable name, which several
// unrelated installations can share.

import type { Priority, ProcessRow } from "@/commands";

type Identity = Pick<ProcessRow, "pid" | "createTime" | "name" | "path" | "webView">;

/**
 * Executables that host whatever they are asked to run. Their file path does
 * not identify an application, so each process gets its own group.
 */
const SHARED_HOSTS = new Set([
  "msedgewebview2.exe",
  "svchost.exe",
  "dllhost.exe",
  "rundll32.exe",
  "conhost.exe",
  "runtimebroker.exe",
  "applicationframehost.exe",
  "taskhostw.exe",
  "taskhost.exe",
  "wudfhost.exe",
  "node.exe",
  "python.exe",
  "pythonw.exe",
  "java.exe",
  "javaw.exe",
  "dotnet.exe",
  "wscript.exe",
  "cscript.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
]);

/** The one-line name of a process; WebView2 helpers show their host app. */
export function processLabel(process: ProcessRow): string {
  return (
    process.webView?.hostDescription ??
    process.webView?.hostName ??
    process.description ??
    process.name
  );
}

/** The identity of one process instance. */
export function procKey(process: Pick<ProcessRow, "pid" | "createTime">): string {
  return `${process.pid}:${process.createTime}`;
}

/** An element id that survives the characters a key can contain. */
export function processRowId(key: string): string {
  return `process-row-${encodeURIComponent(key)}`;
}

/**
 * Normalizes an image path so the same executable reached through a different
 * separator, letter case, or Win32 extended prefix keeps one key.
 */
function imageKey(path: string): string {
  return path
    .replaceAll("/", "\\")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .toLowerCase();
}

export function sharedHost(process: Pick<ProcessRow, "name">): boolean {
  return SHARED_HOSTS.has(process.name.toLowerCase());
}

/** Whether a process can be shown under an application group at all. */
export function canGroup(process: Identity): boolean {
  return !!process.webView || (!!process.path && !sharedHost(process));
}

/**
 * The key of the application group a process belongs to. Instances that have
 * no reliable image path, and shared hosts, stay in groups of their own.
 */
export function applicationKey(process: Identity): string {
  if (process.webView) {
    return `g:webview:${process.webView.browserPid}:${process.webView.browserCreateTime}`;
  }
  if (!process.path || sharedHost(process)) return `g:instance:${procKey(process)}`;
  return `g:image:${imageKey(process.path)}`;
}

/** Every process the group `key` contains, in snapshot order. */
export function applicationMembers(processes: readonly ProcessRow[], key: string): ProcessRow[] {
  return processes.filter((process) => applicationKey(process) === key);
}

/** Compares executable names without their extension and without case. */
export function normalizeProcessName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Whether the process is this application's own executable. The UI refuses to
 * end it: doing so would close the window running the task manager itself.
 */
export function isOwnProcess(
  process: Pick<ProcessRow, "name">,
  selfNames: Iterable<string>
): boolean {
  const name = normalizeProcessName(process.name);
  for (const selfName of selfNames) {
    if (normalizeProcessName(selfName) === name) return true;
  }
  return false;
}

/**
 * Session 0 hosts services and the system itself. Ending those needs the
 * privileged service, not just the app.
 */
export function isSystemProcess(process: Pick<ProcessRow, "sessionId">): boolean {
  return process.sessionId === 0;
}

/** The priority class behind the base priority the snapshot reports. */
export function priorityOf(basePriority: number): Priority | null {
  switch (basePriority) {
    case 4:
      return "idle";
    case 6:
      return "belowNormal";
    case 8:
      return "normal";
    case 10:
      return "aboveNormal";
    case 13:
      return "high";
    case 24:
      return "realtime";
    default:
      return null;
  }
}
