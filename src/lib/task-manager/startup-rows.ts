// Filtering and sorting for the startup tab.

import type { StartupItem } from "@/commands";

export type StartupSort = "name" | "publisher" | "enabled" | "location" | "command";

/** Items whose name, entry, publisher, command or description contains the query. */
export function filterStartupItems(items: readonly StartupItem[], query: string): StartupItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    [item.name, item.entry, item.publisher, item.command, item.description].some((value) =>
      value?.toLocaleLowerCase().includes(needle)
    )
  );
}

/** A copied, sorted list; equal values keep the order they arrived in. */
export function sortStartupItems(items: readonly StartupItem[], sort: StartupSort): StartupItem[] {
  return [...items].sort((a, b) => {
    const left = sort === "enabled" ? Number(a.enabled) : (a[sort] ?? "");
    const right = sort === "enabled" ? Number(b.enabled) : (b[sort] ?? "");
    return String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}
