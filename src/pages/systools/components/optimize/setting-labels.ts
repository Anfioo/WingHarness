// Label helpers for system setting identifiers.
//
// The catalog only carries a stable `settingId`; the locale may or may not
// provide per-setting copy. Keys follow the same convention as the reference
// implementation (`:` and `.` become `_`), so copy can be added later without
// touching the components.

import type { SystemSettingDiagnostic } from "@/lib/systools/system-settings";

/** Locale key for a setting's display name. */
export function settingNameKey(settingId: string): string {
  return `systools.optimize.items.${settingId.replaceAll(".", "_")}.name`;
}

/** Locale key for a setting's description. */
export function settingDescriptionKey(settingId: string): string {
  return `systools.optimize.items.${settingId.replaceAll(".", "_")}.description`;
}

/**
 * Readable fallback derived from the identifier, used until the locale carries
 * per-setting copy. `windows.explorer.show-file-extensions` becomes
 * "Show file extensions".
 */
export function settingFallbackName(settingId: string): string {
  const parts = settingId.split(".").filter((part) => part.length > 0);
  const segment =
    parts.length > 2 ? parts.slice(2).join(" ") : (parts[parts.length - 1] ?? settingId);
  const words = segment.replace(/[-_]+/g, " ").trim();
  if (!words) return settingId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Localized reason shown when a setting cannot be read or changed. */
export function diagnosticReasonKey(diagnostic: SystemSettingDiagnostic): string {
  switch (diagnostic) {
    case "accessDenied":
      return "systools.errors.permissionDenied";
    case "invalidData":
      return "systools.errors.invalidInput";
    case "unsupported":
      return "systools.optimize.skipReasons.unsupported";
    case "stateUnavailable":
      return "systools.optimize.skipReasons.stateUnavailable";
  }
}
