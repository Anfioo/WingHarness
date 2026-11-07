// Helpers the tab bar and the workspace share: the key that identifies a tab,
// the label and icon it shows, and the stored records read back into open tabs.
//
// The key rule is the one `store.ts` persists `windows.json` with, so the two
// can never disagree about what a stored `active` value names.

import type { TabRecord } from "@/commands";

import { tabKey, type DatabaseTab } from "./store";

export type TabKey = string;

export { tabKey };

/** A query tab shows its file name without the extension; a table tab its qualified name. */
export function tabLabel(tab: DatabaseTab, t: (key: string) => string): string {
  if (tab.kind === "query") {
    const name = tab.file.replace(/\.sql$/i, "");
    return name || t("database.tab.untitled");
  }
  return `${tab.schema}.${tab.table}`;
}

/** A query tab reads as a file, a table tab as a grid. */
export function tabIcon(tab: DatabaseTab): "file-code" | "table" {
  return tab.kind === "query" ? "file-code" : "table";
}

/**
 * The tabs a stored window record reopens: query files that no longer exist are
 * dropped, and a record written by an older build cannot duplicate a tab.
 */
export function restoreTabs(stored: TabRecord[], existing: Set<string>): DatabaseTab[] {
  const seen = new Set<string>();
  const tabs: DatabaseTab[] = [];
  for (const record of stored) {
    if (record.kind === "query" && !existing.has(record.file)) continue;
    const tab: DatabaseTab =
      record.kind === "query"
        ? { kind: "query", file: record.file }
        : { kind: "table", target: record.target, schema: record.schema, table: record.table };
    const key = tabKey(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push(tab);
  }
  return tabs;
}
