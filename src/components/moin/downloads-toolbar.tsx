// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { ArrowDown, ArrowUp, ArrowUpDown, Plus, RefreshCw, Undo2 } from "lucide-react";
import type { MoinTask, MoinTaskProgress, MoinTaskStatus } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { percent } from "@/lib/moin/format";

/**
 * Multi-level sorting, persisted in `localStorage["moin.sort"]`.
 *
 * Only the sort preference is stored: task data belongs to the backend and must
 * never be mirrored into web storage.
 */
export type SortKey = "added" | "name" | "size" | "progress" | "speed" | "status";

export type SortDirection = "asc" | "desc";

export interface SortRule {
  key: SortKey;
  direction: SortDirection;
}

export const SORT_KEYS: SortKey[] = ["added", "name", "size", "progress", "speed", "status"];

export const MAX_SORT_RULES = 3;

export const SORT_STORAGE_KEY = "moin.sort";

export const DEFAULT_SORT: SortRule[] = [{ key: "added", direction: "desc" }];

const STATUS_RANK: Record<MoinTaskStatus, number> = {
  downloading: 0,
  connecting: 1,
  moving: 2,
  queued: 3,
  paused: 4,
  failed: 5,
  canceled: 6,
  completed: 7,
};

function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && (SORT_KEYS as string[]).includes(value);
}

/** Reads the stored preference, dropping anything malformed. */
export function loadSortRules(): SortRule[] {
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SORT;
    const rules: SortRule[] = [];
    for (const entry of parsed) {
      if (rules.length >= MAX_SORT_RULES) break;
      if (typeof entry !== "object" || entry === null) continue;
      const { key, direction } = entry as { key?: unknown; direction?: unknown };
      if (!isSortKey(key)) continue;
      if (rules.some((rule) => rule.key === key)) continue;
      rules.push({ key, direction: direction === "asc" ? "asc" : "desc" });
    }
    return rules.length > 0 ? rules : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveSortRules(rules: SortRule[]): void {
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // A full or blocked storage must not break sorting for this session.
  }
}

function compareBy(
  key: SortKey,
  left: MoinTask,
  right: MoinTask,
  progress: Record<string, MoinTaskProgress>
): number {
  switch (key) {
    case "added":
      return left.created_at - right.created_at;
    case "name":
      return left.filename.localeCompare(right.filename);
    case "size":
      return (left.total ?? left.received) - (right.total ?? right.received);
    case "progress":
      return (
        (percent(left.received, left.total) ?? -1) - (percent(right.received, right.total) ?? -1)
      );
    case "speed":
      return (progress[left.id]?.speed ?? 0) - (progress[right.id]?.speed ?? 0);
    case "status":
      return STATUS_RANK[left.status] - STATUS_RANK[right.status];
  }
}

/** Applies every rule in order, so the first rule that differs wins. */
export function sortTasks(
  tasks: MoinTask[],
  rules: SortRule[],
  progress: Record<string, MoinTaskProgress>
): MoinTask[] {
  if (rules.length === 0) return tasks;
  return [...tasks].sort((left, right) => {
    for (const rule of rules) {
      const delta = compareBy(rule.key, left, right, progress);
      if (delta !== 0) return rule.direction === "asc" ? delta : -delta;
    }
    return right.created_at - left.created_at;
  });
}

interface SortMenuProps {
  sort: SortRule[];
  onSortChange: (next: SortRule[]) => void;
}

/**
 * The sort control. It lives in the filter row (`TaskFilters`) between the
 * category picker and the search box, so it is exported rather than kept
 * private to this module.
 */
export function SortMenu({ sort, onSortChange }: SortMenuProps) {
  const { t } = useAppTranslation();

  // Clicking an active key flips its direction; clicking an inactive one
  // appends it as the next tie-breaker, up to three levels.
  const toggle = (key: SortKey) => {
    const index = sort.findIndex((rule) => rule.key === key);
    if (index >= 0) {
      const next = [...sort];
      const current = next[index];
      if (!current) return;
      next[index] = { key, direction: current.direction === "asc" ? "desc" : "asc" };
      onSortChange(next);
      return;
    }
    if (sort.length >= MAX_SORT_RULES) return;
    onSortChange([...sort, { key, direction: key === "name" ? "asc" : "desc" }]);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <ArrowUpDown />
          {t("moin.common.sort")}
          {sort.length > 1 && (
            <span className="text-muted-foreground tabular-nums">{sort.length}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t("moin.common.sort")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SORT_KEYS.map((key) => {
          const index = sort.findIndex((rule) => rule.key === key);
          const rule = index >= 0 ? sort[index] : undefined;
          return (
            <DropdownMenuItem
              key={key}
              disabled={!rule && sort.length >= MAX_SORT_RULES}
              onSelect={(event) => {
                event.preventDefault();
                toggle(key);
              }}
            >
              <span className="flex-1">{t(`moin.sort.${key}`)}</span>
              {rule && (
                <>
                  <span className="text-muted-foreground text-xs tabular-nums">{index + 1}</span>
                  <span
                    title={t(
                      rule.direction === "asc"
                        ? "moin.sort.direction.asc"
                        : "moin.sort.direction.desc"
                    )}
                  >
                    {rule.direction === "asc" ? <ArrowUp /> : <ArrowDown />}
                  </span>
                </>
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSortChange(DEFAULT_SORT)}>
          <Undo2 />
          {t("moin.common.reset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface DownloadsActionsProps {
  loading: boolean;
  onRefresh: () => void;
  onAdd: () => void;
}

/**
 * The add and refresh buttons. They sit at the right end of the status-tab row
 * (passed to `TaskFilters` as `actions`), so this renders a bare cluster with no
 * row of its own.
 */
export function DownloadsActions({ loading, onRefresh, onAdd }: DownloadsActionsProps) {
  const { t } = useAppTranslation();

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={t("moin.common.refresh")}
        disabled={loading}
        onClick={onRefresh}
      >
        <RefreshCw className={loading ? "animate-spin" : ""} />
      </Button>
      <Button type="button" size="sm" onClick={onAdd}>
        <Plus />
        {t("moin.add.submit")}
      </Button>
    </>
  );
}
