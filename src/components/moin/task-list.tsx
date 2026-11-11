// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MoinCategory, MoinTask, MoinTaskProgress } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { TaskContextMenu, type TaskActionHandlers } from "./task-context-menu";
import { ROW_GRID, SelectionCheckbox, TaskRow } from "./task-row";

/**
 * Virtualised download list.
 *
 * Rows are absolutely positioned and measured individually (`measureElement`),
 * so an expanded row simply grows and the rows below shift: the estimate below
 * is only the first-paint guess, never a fixed height.
 */
export interface TaskListProps {
  tasks: MoinTask[];
  progress: Record<string, MoinTaskProgress>;
  categories: MoinCategory[];
  selected: Set<string>;
  expanded: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onToggleExpand: (id: string) => void;
  handlers: TaskActionHandlers;
}

const ESTIMATED_ROW_HEIGHT = 60;

export function TaskList({
  tasks,
  progress,
  categories,
  selected,
  expanded,
  allSelected,
  someSelected,
  onToggleSelect,
  onToggleSelectAll,
  onToggleExpand,
  handlers,
}: TaskListProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories]
  );

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => tasks[index]?.id ?? index,
    overscan: 8,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div className="overflow-hidden rounded-lg border">
      <div
        className={cn(
          ROW_GRID,
          "bg-muted/50 text-muted-foreground border-b px-3 py-2 text-xs font-medium"
        )}
      >
        <SelectionCheckbox
          checked={allSelected}
          indeterminate={someSelected && !allSelected}
          onCheckedChange={() => onToggleSelectAll()}
          label={t("moin.common.selectAll")}
        />
        <span className="min-w-0 truncate">{t("moin.task.filename")}</span>
        <span className="hidden md:block">{t("moin.task.status")}</span>
        <span className="hidden md:block">{t("moin.task.progress")}</span>
        <span className="hidden md:block">{t("moin.task.size")}</span>
        <span className="hidden md:block">{t("moin.task.speed")}</span>
        <span className="hidden md:block">{t("moin.task.eta")}</span>
        <span className="hidden md:block">{t("moin.task.addedAt")}</span>
        <span aria-hidden />
      </div>

      <div ref={scrollRef} className="max-h-[70vh] min-h-0 overflow-auto">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((virtualRow) => {
            const task = tasks[virtualRow.index];
            if (!task) return null;
            return (
              <div
                key={task.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <TaskContextMenu task={task} categories={categories} handlers={handlers}>
                  <TaskRow
                    task={task}
                    progress={progress[task.id]}
                    category={task.category ? categoryById.get(task.category) : undefined}
                    selected={selected.has(task.id)}
                    expanded={expanded.has(task.id)}
                    onToggleSelect={onToggleSelect}
                    onToggleExpand={onToggleExpand}
                  />
                </TaskContextMenu>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
