const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isAbsolutePath(path: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_RE.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

export function toWorkspaceRelativePath(path: string, workspacePath: string): string | null {
  const trimmedPath = path.trim();
  if (!trimmedPath) return "";

  if (!isAbsolutePath(trimmedPath)) {
    return normalizeSeparators(trimmedPath).replace(/^\.\//, "");
  }

  const normalizedWorkspace = trimTrailingSeparators(normalizeSeparators(workspacePath));
  const normalizedPath = trimTrailingSeparators(normalizeSeparators(trimmedPath));
  const compareWorkspace = normalizedWorkspace.toLowerCase();
  const comparePath = normalizedPath.toLowerCase();

  if (comparePath === compareWorkspace) return "";
  if (!comparePath.startsWith(`${compareWorkspace}/`)) return null;

  return normalizedPath.slice(normalizedWorkspace.length + 1);
}
