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
  moinMoveToCategory,
  moinPauseDownload,
  moinResumeDownload,
  moinRetryDownload,
  revealPath,
  type MoinCategory,
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
import { AddDownloadDialog } from "@/components/moin/add-download-dialog";
import { CategoryEditor } from "@/components/moin/category-editor";
import { CategoryManagerDialog } from "@/components/moin/category-manager-dialog";
import { categoryLabel } from "@/components/moin/category-card";
import {
  DownloadsActions,
  SortMenu,
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
  type StatusFilter,
  type TaskFilterState,
} from "@/components/moin/task-filters";
import { TaskBulkActions } from "@/components/moin/task-bulk-actions";
import { TaskList } from "@/components/moin/task-list";
import { canPause, canResume } from "@/components/moin/task-row";
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
  const {
    categories,
    loading: categoriesLoading,
    error: categoriesError,
    create: createCategory,
    update: updateCategory,
    remove: removeCategory,
    reorder: reorderCategories,
  } = useMoinCategories();

  const [filters, setFilters] = useState<TaskFilterState>(clearFilterState);
  const [sort, setSort] = useState<SortRule[]>(loadSortRules);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  // Category management: the editor and the delete confirmation are shared by
  // the two entry points (the filter menu and the manager dialog), so they are
  // owned here rather than by either of them.
  const [managerOpen, setManagerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MoinCategory | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<MoinCategory | null>(null);
  // The list as it was when a save started: the editor only closes once the
  // hook swaps in the saved list, so a rejected write keeps the draft open.
  const [pendingCategorySave, setPendingCategorySave] = useState<MoinCategory[] | null>(null);

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

  // `create` / `update` resolve even when the command is rejected — the hook
  // turns that into `categoriesError` — so the saved list itself is the success
  // signal.
  useEffect(() => {
    if (!pendingCategorySave || categories === pendingCategorySave) return;
    setEditorOpen(false);
    setEditing(null);
    setPendingCategorySave(null);
    toast.success(t("moin.category.saved"));
  }, [categories, pendingCategorySave, t]);

  const visible = useMemo(
    () =>
      sortTasks(
        tasks.filter((task) => taskMatchesFilters(task, filters)),
        sort,
        progress
      ),
    [tasks, filters, sort, progress]
  );

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
      toast.success(t("moin.action.copied"));
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
    onDelete: (task) =>
      setPending({
        titleKey: "moin.action.deleteConfirm",
        descriptionKey: "moin.common.confirmDelete",
        count: 1,
        destructive: true,
        run: () => runCommand(() => moinDeleteDownload(task.id, false)),
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

  const bulkDelete = () => {
    const ids = selectedVisible.map((task) => task.id);
    if (ids.length === 0) return;
    setPending({
      titleKey: "moin.action.deleteConfirm",
      descriptionKey: "moin.common.confirmDelete",
      count: ids.length,
      destructive: true,
      run: async () => {
        await runCommand(() => moinDeleteDownloads(ids, false));
        setSelected(new Set());
      },
    });
  };

  const clearFilters = () => setFilters(clearFilterState());

  const openCategoryCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openCategoryEdit = (category: MoinCategory) => {
    setEditing(category);
    setEditorOpen(true);
  };

  const closeCategoryEditor = () => {
    setEditorOpen(false);
    setEditing(null);
    setPendingCategorySave(null);
  };

  const submitCategory = async (category: MoinCategory) => {
    setSavingCategory(true);
    setPendingCategorySave(categories);
    try {
      if (editing) await updateCategory(category);
      else await createCategory(category);
    } finally {
      setSavingCategory(false);
    }
  };

  // Templates skip the editor, so they commit straight away.
  const createCategoryTemplate = (category: MoinCategory) => {
    setSavingCategory(true);
    void createCategory(category).finally(() => setSavingCategory(false));
  };

  const confirmCategoryDelete = async () => {
    const target = deletingCategory;
    if (!target) return;
    setSavingCategory(true);
    try {
      await removeCategory(target.id);
    } finally {
      setSavingCategory(false);
      setDeletingCategory(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TaskFilters
        tasks={tasks}
        categories={categories}
        status={filters.status}
        onStatusChange={(next: StatusFilter) => setFilters({ ...filters, status: next })}
        categoryIds={filters.categoryIds}
        onCategoryIdsChange={(next) => setFilters({ ...filters, categoryIds: next })}
        onCreateCategory={openCategoryCreate}
        onManageCategories={() => setManagerOpen(true)}
        search={filters.search}
        onSearchChange={(next) => setFilters({ ...filters, search: next })}
        actions={
          <DownloadsActions
            loading={loading}
            onRefresh={() => void reload()}
            onAdd={() => setAddOpen(true)}
          />
        }
        beforeSearch={<SortMenu sort={sort} onSortChange={setSort} />}
        trailing={
          <TaskBulkActions
            selectedCount={selectedVisible.length}
            visibleCount={visible.length}
            pauseableCount={selectedVisible.filter(canPause).length}
            resumeableCount={selectedVisible.filter(canResume).length}
            onPause={bulkPause}
            onResume={bulkResume}
            onDelete={bulkDelete}
          />
        }
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
          <p className="text-muted-foreground text-sm">{t("moin.common.emptyHint")}</p>
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            {t("moin.add.submit")}
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <Download className="text-muted-foreground size-8" />
          <p className="font-medium">{t("moin.filter.noMatches")}</p>
          <p className="text-muted-foreground text-sm">{t("moin.filter.noMatchesHint")}</p>
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

      <CategoryManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        categories={categories}
        tasks={tasks}
        loading={categoriesLoading}
        error={categoriesError}
        saving={savingCategory}
        onCreate={openCategoryCreate}
        onCreateTemplate={createCategoryTemplate}
        onEdit={openCategoryEdit}
        onDelete={setDeletingCategory}
        onReorder={reorderCategories}
      />

      <CategoryEditor
        open={editorOpen}
        category={editing}
        categories={categories}
        saving={savingCategory}
        onOpenChange={(open) => (open ? setEditorOpen(true) : closeCategoryEditor())}
        onSubmit={(category) => void submitCategory(category)}
      />

      <AlertDialog
        open={deletingCategory !== null}
        onOpenChange={(open) => !open && setDeletingCategory(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("moin.common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingCategory
                ? t("moin.category.deleteConfirm", { name: categoryLabel(deletingCategory, t) })
                : ""}{" "}
              {t("moin.category.deleteUncategorized")} {t("moin.common.confirmDelete")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingCategory}>
              {t("moin.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={savingCategory}
              onClick={() => void confirmCategoryDelete()}
            >
              {t("moin.common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
