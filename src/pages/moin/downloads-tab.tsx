// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, LoaderCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  isMoinError,
  moinCancelDownload,
  moinDeleteDownload,
  moinDeleteDownloads,
  moinErrorKey,
  moinForgetDownload,
  moinMoveToCategory,
  moinPauseDownload,
  moinRemoveDownload,
  moinRemoveDownloads,
  moinResumeDownload,
  moinRetryDownload,
  revealPath,
  type MoinTask,
  type MoinTaskProgress,
} from "@/commands";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMoinCategories } from "@/hooks/use-moin-categories";
import { formatSpeed } from "@/lib/moin/format";
import { AddDownloadDialog } from "@/components/moin/add-download-dialog";
import {
  DownloadsToolbar,
  loadSortRules,
  saveSortRules,
  sortTasks,
  type SortRule,
} from "@/components/moin/downloads-toolbar";
import {
  TaskFilters,
  clearFilterState,
  isFilterActive,
  taskMatchesFilters,
  type StatusBucket,
  type TaskFilterState,
} from "@/components/moin/task-filters";
import { TaskList } from "@/components/moin/task-list";
import { canPause, canResume, isActiveStatus } from "@/components/moin/task-row";
import type { TaskActionHandlers } from "@/components/moin/task-context-menu";

/**
 * Downloads tab: filter + sort + selection state, and every command the list can
 * fire. The task snapshot and the event subscription live in the page shell, so
 * this component never calls `useMoinTasks` itself — two snapshots would drift.
 */
interface PendingConfirmation {
  titleKey: string;
  descriptionKey?: string;
  count?: number;
  destructive?: boolean;
  run: () => Promise<void>;
}

export default function DownloadsTab({
  tasks,
  progress,
  loading,
  error,
  reload,
}: {
  tasks: MoinTask[];
  progress: Record<string, MoinTaskProgress>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}) {
  const { t } = useAppTranslation();
  const { categories } = useMoinCategories();

  const [filters, setFilters] = useState<TaskFilterState>(clearFilterState);
  const [sort, setSort] = useState<SortRule[]>(loadSortRules);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  // Sort preference is the only thing this page persists; task data stays in the
  // backend. `saveSortRules` swallows storage failures.
  useEffect(() => {
    saveSortRules(sort);
  }, [sort]);

  // Drop selection and expansion for tasks that no longer exist.
  useEffect(() => {
    const ids = new Set(tasks.map((task) => task.id));
    const prune = (current: Set<string>) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : current;
    };
    setSelected(prune);
    setExpanded(prune);
  }, [tasks]);

  const visible = useMemo(
    () =>
      sortTasks(
        tasks.filter((task) => taskMatchesFilters(task, filters)),
        sort,
        progress
      ),
    [tasks, filters, sort, progress]
  );

  const stats = useMemo(() => {
    let active = 0;
    let completed = 0;
    let archived = 0;
    let speed = 0;
    for (const task of tasks) {
      if (task.archived) {
        archived += 1;
        continue;
      }
      if (isActiveStatus(task.status)) {
        active += 1;
        speed += progress[task.id]?.speed ?? 0;
      } else if (task.status === "completed") {
        completed += 1;
      }
    }
    return { active, completed, archived, speed };
  }, [tasks, progress]);

  const fail = useCallback(
    (failure: unknown) => {
      toast.error(isMoinError(failure) ? t(moinErrorKey(failure.code)) : String(failure));
    },
    [t]
  );

  const runCommand = useCallback(
    async (operation: () => Promise<void>) => {
      try {
        await operation();
        await reload();
      } catch (failure) {
        fail(failure);
      }
    },
    [fail, reload]
  );

  const selectedVisible = useMemo(
    () => visible.filter((task) => selected.has(task.id)),
    [visible, selected]
  );

  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const someSelected = selectedVisible.length > 0;

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(visible.map((task) => task.id)));
  };

  const toggleExpand = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyUrl = async (task: MoinTask) => {
    try {
      await navigator.clipboard.writeText(task.url);
    } catch (failure) {
      fail(failure);
    }
  };

  const handlers: TaskActionHandlers = {
    onPause: (task) => void runCommand(() => moinPauseDownload(task.id)),
    onResume: (task) => void runCommand(() => moinResumeDownload(task.id)),
    onRetry: (task) => void runCommand(() => moinRetryDownload(task.id)),
    onCancel: (task) => void runCommand(() => moinCancelDownload(task.id)),
    onReveal: (task) => void runCommand(() => revealPath(task.dest)),
    onCopyUrl: (task) => void copyUrl(task),
    onMoveToCategory: (task, category) =>
      void runCommand(() => moinMoveToCategory([task.id], category)),
    onRemove: (task) =>
      setPending({
        titleKey: "moin.action.removeConfirm",
        count: 1,
        run: () => runCommand(() => moinRemoveDownload(task.id)),
      }),
    onDelete: (task) =>
      setPending({
        titleKey: "moin.action.deleteConfirm",
        descriptionKey: "moin.common.confirmDelete",
        count: 1,
        destructive: true,
        run: () => runCommand(() => moinDeleteDownload(task.id)),
      }),
    onForget: (task) =>
      setPending({
        titleKey: "moin.action.forgetConfirm",
        count: 1,
        run: () => runCommand(() => moinForgetDownload(task.id)),
      }),
  };

  const bulkPause = () => {
    const ids = selectedVisible.filter(canPause).map((task) => task.id);
    if (ids.length === 0) return;
    void runCommand(async () => {
      for (const id of ids) await moinPauseDownload(id);
    });
  };

  const bulkResume = () => {
    const ids = selectedVisible.filter(canResume).map((task) => task.id);
    if (ids.length === 0) return;
    void runCommand(async () => {
      for (const id of ids) await moinResumeDownload(id);
    });
  };

  const bulkRemove = () => {
    const ids = selectedVisible.map((task) => task.id);
    if (ids.length === 0) return;
    setPending({
      titleKey: "moin.action.removeConfirm",
      count: ids.length,
      run: async () => {
        await runCommand(() => moinRemoveDownloads(ids));
        setSelected(new Set());
      },
    });
  };

  const bulkDelete = () => {
    const ids = selectedVisible.map((task) => task.id);
    if (ids.length === 0) return;
    setPending({
      titleKey: "moin.action.deleteConfirm",
      descriptionKey: "moin.common.confirmDelete",
      count: ids.length,
      destructive: true,
      run: async () => {
        await runCommand(() => moinDeleteDownloads(ids));
        setSelected(new Set());
      },
    });
  };

  const clearFilters = () => setFilters(clearFilterState());

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span>
          {t("moin.filter.active")}{" "}
          <span className="text-foreground tabular-nums">{stats.active}</span>
        </span>
        <span>
          {t("moin.filter.completed")}{" "}
          <span className="text-foreground tabular-nums">{stats.completed}</span>
        </span>
        <span>
          {t("moin.filter.archived")}{" "}
          <span className="text-foreground tabular-nums">{stats.archived}</span>
        </span>
        <span>
          {t("moin.task.speed")}{" "}
          <span className="text-foreground tabular-nums">{formatSpeed(stats.speed)}</span>
        </span>
        <span className="ml-auto tabular-nums">
          {t("moin.task.count", { count: visible.length })}
        </span>
      </div>

      <DownloadsToolbar
        loading={loading}
        onRefresh={() => void reload()}
        onAdd={() => setAddOpen(true)}
        sort={sort}
        onSortChange={setSort}
        selectedCount={selectedVisible.length}
        visibleCount={visible.length}
        pauseableCount={selectedVisible.filter(canPause).length}
        resumeableCount={selectedVisible.filter(canResume).length}
        onSelectAll={() => setSelected(new Set(visible.map((task) => task.id)))}
        onSelectNone={() => setSelected(new Set())}
        onBulkPause={bulkPause}
        onBulkResume={bulkResume}
        onBulkRemove={bulkRemove}
        onBulkDelete={bulkDelete}
      />

      <TaskFilters
        tasks={tasks}
        categories={categories}
        buckets={filters.buckets}
        onBucketsChange={(next: Set<StatusBucket>) => setFilters({ ...filters, buckets: next })}
        categoryIds={filters.categoryIds}
        onCategoryIdsChange={(next) => setFilters({ ...filters, categoryIds: next })}
        search={filters.search}
        onSearchChange={(next) => setFilters({ ...filters, search: next })}
      />

      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {t(error)}
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <div className="text-muted-foreground flex items-center justify-center gap-2 rounded-lg border py-12 text-sm">
          <LoaderCircle className="size-4 animate-spin" />
          {t("moin.common.loading")}
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <Download className="text-muted-foreground size-8" />
          <p className="font-medium">{t("moin.common.empty")}</p>
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            {t("moin.add.submit")}
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <Download className="text-muted-foreground size-8" />
          <p className="font-medium">{t("moin.common.empty")}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {isFilterActive(filters) && (
              <Button type="button" size="sm" variant="outline" onClick={clearFilters}>
                {t("moin.common.clearFilters")}
              </Button>
            )}
            <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
              <Plus />
              {t("moin.add.submit")}
            </Button>
          </div>
        </div>
      ) : (
        <TaskList
          tasks={visible}
          progress={progress}
          categories={categories}
          selected={selected}
          expanded={expanded}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          onToggleExpand={toggleExpand}
          handlers={handlers}
        />
      )}

      <AddDownloadDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        categories={categories}
        onAdded={reload}
      />

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? t(pending.titleKey) : null}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.count !== undefined && (
                <span className="block">{t("moin.task.count", { count: pending.count })}</span>
              )}
              {pending?.descriptionKey ? t(pending.descriptionKey) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("moin.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={
                pending?.destructive ? buttonVariants({ variant: "destructive" }) : undefined
              }
              onClick={() => {
                const run = pending?.run;
                setPending(null);
                if (run) void run();
              }}
            >
              {t("moin.common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
