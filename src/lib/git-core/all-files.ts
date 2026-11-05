export interface AllFilesEntry<T> {
  path: string;
  change: T | null;
}

export function allFiles<T>(
  paths: string[],
  changes: T[],
  pathOf: (change: T) => string
): AllFilesEntry<T>[] {
  const byPath = new Map<string, T>();
  for (const change of changes) byPath.set(pathOf(change), change);
  const seen = new Set<string>();
  const out: AllFilesEntry<T>[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, change: byPath.get(path) ?? null });
  }
  for (const change of changes) {
    const path = pathOf(change);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, change });
  }
  return out;
}

export function foldersWithChanges<T>(entries: AllFilesEntry<T>[]): Set<string> {
  const folders = new Set<string>();
  for (const entry of entries) {
    if (!entry.change) continue;
    const parts = entry.path.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      folders.add(prefix);
    }
  }
  return folders;
}
