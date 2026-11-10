// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
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
  stalled: 5,
  failed: 6,
  canceled: 7,
  completed: 8,
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

function SortMenu({ sort, onSortChange }: SortMenuProps) {
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

export interface DownloadsToolbarProps {
  loading: boolean;
  onRefresh: () => void;
  onAdd: () => void;
  sort: SortRule[];
  onSortChange: (next: SortRule[]) => void;
  selectedCount: number;
  visibleCount: number;
  pauseableCount: number;
  resumeableCount: number;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onInvertSelection: () => void;
  onBulkPause: () => void;
  onBulkResume: () => void;
  onBulkRemove: () => void;
  onBulkDelete: () => void;
}

export function DownloadsToolbar({
  loading,
  onRefresh,
  onAdd,
  sort,
  onSortChange,
  selectedCount,
  visibleCount,
  pauseableCount,
  resumeableCount,
  onSelectAll,
  onSelectNone,
  onInvertSelection,
  onBulkPause,
  onBulkResume,
  onBulkRemove,
  onBulkDelete,
}: DownloadsToolbarProps) {
  const { t } = useAppTranslation();
  const hasSelection = selectedCount > 0;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button type="button" size="sm" onClick={onAdd}>
        <Plus />
        {t("moin.add.submit")}
      </Button>
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

      <Separator orientation="vertical" className="mx-1 hidden h-6 sm:block" />

      <SortMenu sort={sort} onSortChange={onSortChange} />

      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={visibleCount === 0 || selectedCount === visibleCount}
          onClick={onSelectAll}
        >
          {t("moin.common.selectAll")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!hasSelection}
          onClick={onSelectNone}
        >
          {t("moin.common.selectNone")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={visibleCount === 0}
          onClick={onInvertSelection}
        >
          {t("moin.common.invertSelection")}
        </Button>

        {hasSelection && (
          <>
            <span className="text-muted-foreground px-1 text-xs tabular-nums">
              {t("moin.common.selectedCount", { selected: selectedCount, total: visibleCount })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pauseableCount === 0}
              onClick={onBulkPause}
            >
              <Pause />
              {t("moin.action.pause")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resumeableCount === 0}
              onClick={onBulkResume}
            >
              <Play />
              {t("moin.action.resume")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onBulkRemove}>
              {t("moin.action.remove")}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onBulkDelete}>
              <Trash2 />
              {t("moin.action.delete")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
