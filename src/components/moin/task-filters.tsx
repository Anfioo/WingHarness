// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { Search, X } from "lucide-react";
import type { MoinCategory, MoinTask } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { isActiveStatus } from "./task-row";

/**
 * Status filter buckets.
 *
 * `canceled` has no chip of its own in the frozen key set, so it is grouped
 * under `failed`: both are terminal states that need the user to act. Archived
 * is orthogonal — an archived task keeps its status but is only listed when the
 * `archived` bucket is selected.
 */
export type StatusBucket = "active" | "completed" | "paused" | "failed" | "stalled" | "archived";

export const STATUS_BUCKETS: StatusBucket[] = [
  "active",
  "completed",
  "paused",
  "failed",
  "stalled",
  "archived",
];

/** Default view: everything the user still cares about, archived excluded. */
export const DEFAULT_STATUS_BUCKETS: StatusBucket[] = ["active", "completed", "failed"];

const BUCKET_MATCHERS: Record<StatusBucket, (task: MoinTask) => boolean> = {
  active: (task) => !task.archived && isActiveStatus(task.status),
  completed: (task) => !task.archived && task.status === "completed",
  paused: (task) => !task.archived && task.status === "paused",
  failed: (task) => !task.archived && (task.status === "failed" || task.status === "canceled"),
  stalled: (task) => !task.archived && task.status === "stalled",
  archived: (task) => task.archived,
};

export function matchesStatusBucket(task: MoinTask, bucket: StatusBucket): boolean {
  return BUCKET_MATCHERS[bucket](task);
}

export interface TaskFilterState {
  buckets: Set<StatusBucket>;
  categoryIds: Set<string>;
  search: string;
}

/** Row visibility: any selected bucket, any selected category, and the search. */
export function taskMatchesFilters(task: MoinTask, filters: TaskFilterState): boolean {
  let statusHit = false;
  for (const bucket of filters.buckets) {
    if (BUCKET_MATCHERS[bucket](task)) {
      statusHit = true;
      break;
    }
  }
  if (!statusHit) return false;

  // An empty category selection means "every category", not "none".
  if (filters.categoryIds.size > 0) {
    if (task.category === null || !filters.categoryIds.has(task.category)) return false;
  }

  const needle = filters.search.trim().toLowerCase();
  if (!needle) return true;
  return task.filename.toLowerCase().includes(needle) || task.url.toLowerCase().includes(needle);
}

export interface TaskFiltersProps {
  tasks: MoinTask[];
  categories: MoinCategory[];
  buckets: Set<StatusBucket>;
  onBucketsChange: (next: Set<StatusBucket>) => void;
  categoryIds: Set<string>;
  onCategoryIdsChange: (next: Set<string>) => void;
  search: string;
  onSearchChange: (next: string) => void;
}

export function TaskFilters({
  tasks,
  categories,
  buckets,
  onBucketsChange,
  categoryIds,
  onCategoryIdsChange,
  search,
  onSearchChange,
}: TaskFiltersProps) {
  const { t } = useAppTranslation();

  const toggleBucket = (bucket: StatusBucket) => {
    const next = new Set(buckets);
    if (next.has(bucket)) next.delete(bucket);
    else next.add(bucket);
    onBucketsChange(next);
  };

  const toggleCategory = (id: string) => {
    const next = new Set(categoryIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onCategoryIdsChange(next);
  };

  const allSelected = buckets.size === STATUS_BUCKETS.length;

  return (
    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
      <div
        className="flex min-w-0 flex-wrap items-center gap-1"
        role="group"
        aria-label={t("moin.common.filter")}
      >
        <Button
          type="button"
          size="sm"
          variant={allSelected ? "secondary" : "ghost"}
          onClick={() =>
            onBucketsChange(allSelected ? new Set(DEFAULT_STATUS_BUCKETS) : new Set(STATUS_BUCKETS))
          }
        >
          {t("moin.filter.all")}
        </Button>
        {STATUS_BUCKETS.map((bucket) => {
          const count = tasks.filter((task) => BUCKET_MATCHERS[bucket](task)).length;
          const active = buckets.has(bucket);
          return (
            <Button
              key={bucket}
              type="button"
              size="sm"
              variant={active ? "secondary" : "ghost"}
              aria-pressed={active}
              onClick={() => toggleBucket(bucket)}
            >
              {t(`moin.filter.${bucket}`)}
              <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
            </Button>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              {t("moin.task.category")}
              {categoryIds.size > 0 && (
                <span className="text-muted-foreground tabular-nums">{categoryIds.size}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>{t("moin.task.category")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {categories.length === 0 ? (
              <DropdownMenuLabel className="text-muted-foreground font-normal">
                {t("moin.category.empty")}
              </DropdownMenuLabel>
            ) : (
              categories.map((category) => (
                <DropdownMenuCheckboxItem
                  key={category.id}
                  checked={categoryIds.has(category.id)}
                  onCheckedChange={() => toggleCategory(category.id)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: category.color || "var(--color-muted-foreground)" }}
                  />
                  {category.name}
                </DropdownMenuCheckboxItem>
              ))
            )}
            {categoryIds.size > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={false}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => onCategoryIdsChange(new Set())}
                >
                  <X />
                  {t("moin.common.clear")}
                </DropdownMenuCheckboxItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="relative min-w-0">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("moin.common.search")}
            aria-label={t("moin.common.search")}
            className="h-8 w-full pl-7 text-sm sm:w-56"
          />
          {search && (
            <button
              type="button"
              aria-label={t("moin.common.clear")}
              onClick={() => onSearchChange("")}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shared empty-selection sentinel so callers can compare cheaply. */
export function isFilterActive(filters: TaskFilterState): boolean {
  return (
    filters.buckets.size !== DEFAULT_STATUS_BUCKETS.length ||
    DEFAULT_STATUS_BUCKETS.some((bucket) => !filters.buckets.has(bucket)) ||
    filters.categoryIds.size > 0 ||
    filters.search.trim().length > 0
  );
}

/** Small helper used by the empty state's "clear filters" affordance. */
export function clearFilterState(): TaskFilterState {
  return { buckets: new Set(DEFAULT_STATUS_BUCKETS), categoryIds: new Set(), search: "" };
}
