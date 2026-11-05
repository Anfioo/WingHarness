// Presentation-only mappings shared by the startup components. Keeping them in
// one place avoids drift between the row, the queue, and the plan dialog.

import {
  isStartupToggleable,
  sourceFilterOf,
  type StartupArtifact,
  type StartupConfiguredState,
  type StartupCoverageReason,
  type StartupDesiredState,
  type StartupSourceFilter,
  type StartupSourceKind,
} from "@/lib/systools/startup";

const STARTUP_SOURCE_KINDS: readonly StartupSourceKind[] = [
  "registryRun",
  "startupFolder",
  "scheduledTask",
  "service",
  "packagedStartupTask",
  "advancedAutoRun",
];

/** i18n key for the state a queued change asks for. */
export function desiredStateLabelKey(state: StartupDesiredState): string {
  switch (state) {
    case "enabled":
      return "systools.startup.actions.enable";
    case "disabled":
      return "systools.startup.actions.disable";
    case "removed":
      return "systools.startup.actions.remove";
  }
}

/** i18n key for a configured state badge. */
export function configuredStateLabelKey(state: StartupConfiguredState): string {
  return `systools.startup.states.${state}`;
}

/** i18n key explaining why an item cannot be toggled, or null when it can. */
export function startupToggleBlockedKey(item: StartupArtifact): string | null {
  if (!isStartupToggleable(item)) {
    switch (item.controlCapability) {
      case "systemManaged":
        return "systools.startup.control.systemManaged";
      case "policyManaged":
        return "systools.startup.control.policyManaged";
      case "viewOnly":
        return "systools.startup.control.viewOnly";
      case "removeOnly":
        return "systools.startup.control.removeOnly";
      default:
        return "systools.startup.control.viewOnly";
    }
  }
  if (item.configuredState === "notApplicable") {
    return "systools.startup.states.notApplicable";
  }
  if (item.configuredState === "unknown") {
    return "systools.startup.states.unknown";
  }
  return null;
}

/** i18n key for a scan-coverage failure reason. */
export function coverageReasonKey(reason: StartupCoverageReason | null): string {
  switch (reason) {
    case "accessDenied":
      return "systools.errors.permissionDenied";
    case "cancelled":
      return "systools.startup.toast.scanCancelled";
    case "invalidData":
      return "systools.errors.invalidInput";
    case "notImplemented":
      return "systools.common.notImplemented";
    case "stateUnavailable":
      return "systools.startup.states.unknown";
    case "apiUnavailable":
    case "unsupportedOperatingSystem":
    case null:
      return "systools.errors.unknown";
  }
}

function isStartupSourceKind(value: string): value is StartupSourceKind {
  return (STARTUP_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Coverage entries carry a native source id rather than a source kind. When the
 * id matches a known kind it is localized; otherwise the caller shows the raw
 * id so the source is at least identifiable.
 */
export function startupSourceLabelKey(value: string): string | null {
  return isStartupSourceKind(value) ? `systools.startup.sources.${sourceFilterOf(value)}` : null;
}

/** i18n key for one top-level source filter. */
export function startupFilterLabelKey(filter: StartupSourceFilter): string {
  return `systools.startup.sources.${filter}`;
}

/**
 * Scan progress reports native source ids rather than kinds. Unknown ids return
 * null so the caller can fall back to the raw id instead of a wrong label.
 */
export function startupScanSourceLabelKey(sourceId: string): string | null {
  switch (sourceId) {
    case "windows.registry.run":
      return "systools.startup.sources.registry";
    case "windows.startup_folder.user":
    case "windows.startup_folder.common":
      return "systools.startup.sources.folder";
    case "windows.services":
      return "systools.startup.sources.service";
    case "windows.scheduled_tasks":
      return "systools.startup.sources.task";
    case "windows.packaged_startup_tasks":
      return "systools.startup.sources.app";
    case "windows.advanced_autoruns":
      return "systools.startup.sources.advanced";
    default:
      return null;
  }
}
