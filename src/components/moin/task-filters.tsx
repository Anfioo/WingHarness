// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { Plus, Search, Settings2, X } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import type { MoinCategory, MoinTask } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * Status tabs. Exactly one bucket is selected at a time.
 *
 * The page only distinguishes three outcomes: everything still unfinished
 * (queued, connecting, downloading, moving, paused and canceled), completed, and
 * failed. The row badge keeps the finer status.
 */
export type StatusBucket = "incomplete" | "completed" | "failed";

export const STATUS_BUCKETS: StatusBucket[] = ["incomplete", "completed", "failed"];

export type StatusFilter = "all" | StatusBucket;

const BUCKET_MATCHERS: Record<StatusFilter, (task: MoinTask) => boolean> = {
  all: () => true,
  incomplete: (task) => task.status !== "completed" && task.status !== "failed",
  completed: (task) => task.status === "completed",
  failed: (task) => task.status === "failed",
};

export function matchesStatusBucket(task: MoinTask, bucket: StatusFilter): boolean {
  return BUCKET_MATCHERS[bucket](task);
}

export interface TaskFilterState {
  status: StatusFilter;
  categoryIds: Set<string>;
  search: string;
}

/** Row visibility: the selected status, any selected category, and the search. */
export function taskMatchesFilters(task: MoinTask, filters: TaskFilterState): boolean {
  if (!BUCKET_MATCHERS[filters.status](task)) return false;

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
  status: StatusFilter;
  onStatusChange: (next: StatusFilter) => void;
  categoryIds: Set<string>;
  onCategoryIdsChange: (next: Set<string>) => void;
  /** Opens the category editor on a blank record. */
  onCreateCategory: () => void;
  /** Opens the manager dialog behind the dropdown. */
  onManageCategories: () => void;
  search: string;
  onSearchChange: (next: string) => void;
  /** Right end of the status-tab row, e.g. the add and refresh buttons. */
  actions?: ReactNode;
  /** Sits between the category picker and the search box, e.g. the sort menu. */
  beforeSearch?: ReactNode;
  /** Right-aligned slot on the category/search row, e.g. the bulk actions. */
  trailing?: ReactNode;
}

export function TaskFilters({
  tasks,
  categories,
  status,
  onStatusChange,
  categoryIds,
  onCategoryIdsChange,
  onCreateCategory,
  onManageCategories,
  search,
  onSearchChange,
  actions,
  beforeSearch,
  trailing,
}: TaskFiltersProps) {
  const { t } = useAppTranslation();

  const toggleCategory = (id: string) => {
    const next = new Set(categoryIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onCategoryIdsChange(next);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <RadioGroupPrimitive.Root
          value={status}
          onValueChange={(value) => onStatusChange(value as StatusFilter)}
          aria-label={t("moin.common.filter")}
          orientation="horizontal"
          className="bg-muted text-muted-foreground flex h-9 w-fit max-w-full min-w-0 items-center gap-0 overflow-x-auto rounded-lg p-[3px]"
        >
          {(["all", ...STATUS_BUCKETS] as StatusFilter[]).map((filter) => {
            const count =
              filter === "all"
                ? tasks.length
                : tasks.filter((task) => BUCKET_MATCHERS[filter](task)).length;
            return (
              <RadioGroupPrimitive.Item
                key={filter}
                value={filter}
                className="focus-visible:ring-ring data-[state=checked]:bg-background data-[state=checked]:text-foreground inline-flex h-full shrink-0 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 data-[state=checked]:shadow-sm"
              >
                {t(`moin.filter.${filter}`)}
                <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
              </RadioGroupPrimitive.Item>
            );
          })}
        </RadioGroupPrimitive.Root>

        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              {t("moin.task.category")}
              {/* One fixed slot: the plus turns into the count, so the button
                  keeps its width whether nothing or one/two categories are on. */}
              <span className="text-muted-foreground inline-flex min-w-5 justify-center tabular-nums">
                {categoryIds.size > 0 ? (
                  categoryIds.size
                ) : (
                  <Plus className="size-3.5" aria-hidden />
                )}
              </span>
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
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onCreateCategory()}>
              <Plus />
              {t("moin.category.new")}
            </DropdownMenuItem>
            {categoryIds.size > 0 && (
              <DropdownMenuItem onSelect={() => onCategoryIdsChange(new Set())}>
                <X />
                {t("moin.common.clear")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onManageCategories()}>
              <Settings2 />
              {t("moin.category.manage")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {beforeSearch}

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

        {trailing}
      </div>
    </div>
  );
}

/** Whether any status, category or search filter differs from the All view. */
export function isFilterActive(filters: TaskFilterState): boolean {
  return (
    filters.status !== "all" || filters.categoryIds.size > 0 || filters.search.trim().length > 0
  );
}

/** Small helper used by the empty state's "clear filters" affordance. */
export function clearFilterState(): TaskFilterState {
  return { status: "all", categoryIds: new Set(), search: "" };
}
