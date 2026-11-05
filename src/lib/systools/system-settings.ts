// System optimization DTOs and thin command wrappers.
//
// The Rust DTOs are camelCase; these types mirror them one-to-one so the page
// never has to work with opaque payloads.

import {
  systoolsSystemSettingsCancelScan,
  systoolsSystemSettingsExecuteChange,
  systoolsSystemSettingsPrepareChange,
  systoolsSystemSettingsScan,
} from "@/commands/services/systools";

export type SystemSettingsPlatform = "windows";

export type SystemSettingCategory =
  | "performance"
  | "productivity"
  | "privacy"
  | "storage"
  | "gaming"
  | "appearance";

/** Category order used by the page. */
export const SYSTEM_SETTING_CATEGORIES: SystemSettingCategory[] = [
  "appearance",
  "gaming",
  "performance",
  "privacy",
  "productivity",
  "storage",
];

export type SystemSettingSelectionKind = "oneClick" | "custom";
export type SystemSettingStatus = "recommended" | "optimized" | "unavailable";
export type SystemSettingRiskLevel = "standard" | "caution" | "high";

export type SystemSettingDiagnostic =
  | "accessDenied"
  | "invalidData"
  | "unsupported"
  | "stateUnavailable";

export interface SystemSettingItem {
  settingId: string;
  category: SystemSettingCategory;
  selectionKind: SystemSettingSelectionKind;
  riskLevel: SystemSettingRiskLevel;
  status: SystemSettingStatus;
  selectedByDefault: boolean;
  restoreAvailable: boolean;
  requiresRestart: boolean;
  requiresElevation: boolean;
  diagnostic: SystemSettingDiagnostic | null;
}

export interface SystemSettingsCatalogSummary {
  itemCount: number;
  recommendedCount: number;
  optimizedCount: number;
  selectedCount: number;
  unavailableCount: number;
}

export interface SystemSettingsCatalog {
  schemaVersion: number;
  scanId: string;
  catalogRevision: string;
  platform: SystemSettingsPlatform;
  scannedAtMs: number;
  items: SystemSettingItem[];
  summary: SystemSettingsCatalogSummary;
  elapsedMs: number;
  recoveryAvailable: boolean;
}

export type SystemSettingTargetState = "optimized" | "default";

export interface SystemSettingChangeSelectionItem {
  settingId: string;
  target: SystemSettingTargetState;
}

export interface SystemSettingsChangeSelection {
  scanId: string;
  items: SystemSettingChangeSelectionItem[];
}

export type SystemSettingChangeSkipReason =
  | "alreadyOptimized"
  | "alreadyDefault"
  | "catalogExpired"
  | "settingChanged"
  | "settingMissing"
  | "stateUnavailable"
  | "unsupported";

export interface SystemSettingChangePlanItem {
  settingId: string;
  category: SystemSettingCategory;
  target: SystemSettingTargetState;
  requiresRestart: boolean;
  requiresElevation: boolean;
}

export interface SystemSettingChangeSkippedItem {
  settingId: string;
  reason: SystemSettingChangeSkipReason;
}

export interface SystemSettingsChangePlan {
  schemaVersion: number;
  planId: string;
  scanId: string;
  catalogRevision: string;
  createdAtMs: number;
  expiresAtMs: number;
  items: SystemSettingChangePlanItem[];
  skippedItems: SystemSettingChangeSkippedItem[];
  requiresConfirmation: boolean;
  requiresRestart: boolean;
}

export type SystemSettingChangeOutcomeStatus = "changed" | "unchanged" | "failed";

export type SystemSettingChangeFailureReason =
  | "settingChanged"
  | "permissionDenied"
  | "unsupported"
  | "verificationFailed"
  | "platformFailure"
  | "userCancelled";

export interface SystemSettingChangeItemResult {
  settingId: string;
  status: SystemSettingChangeOutcomeStatus;
  verified: boolean;
  failureReason: SystemSettingChangeFailureReason | null;
}

export interface SystemSettingsChangeResult {
  planId: string;
  changedCount: number;
  failedCount: number;
  requiresRestart: boolean;
  recoveryAvailable: boolean;
  items: SystemSettingChangeItemResult[];
  catalog: SystemSettingsCatalog | null;
}

/** Scan every implemented system setting. */
export async function scanSystemSettings(): Promise<SystemSettingsCatalog> {
  return (await systoolsSystemSettingsScan()) as unknown as SystemSettingsCatalog;
}

/** Stop an in-flight settings scan. */
export async function cancelSystemSettingsScan(): Promise<void> {
  await systoolsSystemSettingsCancelScan();
}

/** Turn a selection into a reviewable change plan. */
export async function prepareSystemSettingsChange(
  selection: SystemSettingsChangeSelection
): Promise<SystemSettingsChangePlan> {
  // The command DTO is still an opaque placeholder; once it carries its final
  // shape this cast disappears.
  const payload = selection as unknown as Parameters<typeof systoolsSystemSettingsPrepareChange>[0];
  return (await systoolsSystemSettingsPrepareChange(
    payload
  )) as unknown as SystemSettingsChangePlan;
}

/** Apply a prepared change plan. */
export async function executeSystemSettingsChange(
  planId: string
): Promise<SystemSettingsChangeResult> {
  return (await systoolsSystemSettingsExecuteChange(
    planId
  )) as unknown as SystemSettingsChangeResult;
}

/** Group items by category while keeping the catalog order stable. */
export function groupByCategory(
  items: SystemSettingItem[]
): Array<{ category: SystemSettingCategory; items: SystemSettingItem[] }> {
  const groups = new Map<SystemSettingCategory, SystemSettingItem[]>();
  for (const category of SYSTEM_SETTING_CATEGORIES) {
    groups.set(category, []);
  }
  for (const item of items) {
    const group = groups.get(item.category);
    if (group) group.push(item);
  }
  return SYSTEM_SETTING_CATEGORIES.map((category) => ({
    category,
    items: groups.get(category) ?? [],
  })).filter((group) => group.items.length > 0);
}

/** Whether the switch may be operated at all. */
export function isSettingSelectable(item: SystemSettingItem): boolean {
  return item.status !== "unavailable";
}

/** The target implied by flipping one switch. */
export function targetForFlip(item: SystemSettingItem): SystemSettingTargetState {
  return item.status === "optimized" ? "default" : "optimized";
}

/** Whether a restore-all selection may include this item. */
export function canRestore(item: SystemSettingItem): boolean {
  return item.restoreAvailable && item.status !== "unavailable";
}

/** Build the selection that restores every setting with a valid baseline. */
export function buildRestoreSelection(
  catalog: SystemSettingsCatalog
): SystemSettingsChangeSelection {
  return {
    scanId: catalog.scanId,
    items: catalog.items.filter(canRestore).map((item) => ({
      settingId: item.settingId,
      target: "default",
    })),
  };
}
