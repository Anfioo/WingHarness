// The size caps the preview engine obeys.
//
// The values are preferences, but the callers are not all React components:
// `bridge.ts` and the archive session read them at call time, so the host
// publishes each loaded or changed preferences object here. The in-memory
// default matches the backend's default, so a preview opened before the file
// has loaded still behaves the same.

import type { PreviewPreferences } from "@/commands";

const MIB = 1024 * 1024;

let wholeFileBytes = 512 * MIB;
let archiveEntryBytes = 256 * MIB;

/** Publish the caps from a preferences object; the host calls this on every change. */
export function applyPreviewLimits(
  preferences: Pick<PreviewPreferences, "maxPreviewMiB" | "maxArchiveEntryMiB">
): void {
  wholeFileBytes = preferences.maxPreviewMiB * MIB;
  archiveEntryBytes = preferences.maxArchiveEntryMiB * MIB;
}

/** The largest file a whole-file preview reads into memory. */
export function wholeFileLimit(): number {
  return wholeFileBytes;
}

/** The largest file an archive viewer extracts from inside an archive. */
export function archiveEntryLimit(): number {
  return archiveEntryBytes;
}
