// The standalone window's file tabs, as pure functions.
//
// A hand-off lists every selected file; a tab can be closed, and the window's
// active file is always one of the tabs that remain. Keeping the arithmetic
// here makes the arrow-key and close-button behaviour testable without a
// React tree.

/** The part of a preview entry a tab needs. */
export interface TabEntry {
  path: string;
  name: string;
}

/** The tabs still open, in hand-off order. */
export function visibleTabs<T extends TabEntry>(entries: T[], closed: ReadonlySet<string>): T[] {
  return entries.filter((entry) => !closed.has(entry.path));
}

/**
 * The tab one step from `activePath`. Left/up wraps to the end and right/down
 * wraps to the start; a path that is no longer open falls back to the first.
 */
export function stepTab<T extends TabEntry>(
  tabs: T[],
  activePath: string | null,
  direction: 1 | -1
): string | null {
  if (!tabs.length) return null;
  const found = tabs.findIndex((tab) => tab.path === activePath);
  if (found < 0) return direction > 0 ? tabs[0].path : tabs[tabs.length - 1].path;
  return tabs[(found + direction + tabs.length) % tabs.length].path;
}

/**
 * Remove a tab. A non-active tab leaves the selection alone; the active one
 * hands over to its right neighbour, or its left when it was last. Closing the
 * only tab leaves `activePath` null and the caller hides the window.
 */
export function closeTab<T extends TabEntry>(
  tabs: T[],
  activePath: string | null,
  path: string
): { tabs: T[]; activePath: string | null } {
  const at = tabs.findIndex((tab) => tab.path === path);
  if (at < 0) return { tabs, activePath };
  const remaining = tabs.filter((tab) => tab.path !== path);
  if (!remaining.length) return { tabs: remaining, activePath: null };
  if (path !== activePath) return { tabs: remaining, activePath };
  return { tabs: remaining, activePath: remaining[Math.min(at, remaining.length - 1)].path };
}
