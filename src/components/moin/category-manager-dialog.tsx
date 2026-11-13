// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { LoaderCircle, Plus } from "lucide-react";
import type { MoinCategory, MoinTask } from "@/commands";
import { CategoryCard } from "@/components/moin/category-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The three categories a fresh install seeds. They are offered when the list is
 * empty so a user who deleted them can restore the defaults in one click; the
 * stored names stay English and the UI translates them by id.
 */
const TEMPLATES: { id: string; name: string; color: string; order: number; exts: string[] }[] = [
  {
    id: "documents",
    name: "Documents",
    color: "#3b82f6",
    order: 10,
    exts: ["doc", "pdf", "epub", "txt", "md"],
  },
  {
    id: "videos",
    name: "Videos",
    color: "#ec4899",
    order: 20,
    exts: ["mp4", "mkv", "avi", "mov", "webm"],
  },
  {
    id: "archives",
    name: "Archives",
    color: "#f59e0b",
    order: 30,
    exts: ["zip", "7z", "rar", "tar", "gz"],
  },
];

export type CategoryManagerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: MoinCategory[];
  /** Shared task snapshot, used for the per-category hit count. */
  tasks: MoinTask[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  /** Opens the editor on a blank record. */
  onCreate: () => void;
  /** Creates one of the seed templates as-is. */
  onCreateTemplate: (category: MoinCategory) => void;
  onEdit: (category: MoinCategory) => void;
  onDelete: (category: MoinCategory) => void;
  onReorder: (ids: string[]) => Promise<void>;
};

/**
 * Category management, opened from the 分类 filter menu.
 *
 * The data comes from the downloads tab's single `useMoinCategories()` instance
 * — a second hook here would drift from the filter list. The editor and the
 * delete confirmation live in the tab too, so both entry points (this dialog
 * and the menu's 新增分类) share one draft state.
 */
export function CategoryManagerDialog({
  open,
  onOpenChange,
  categories,
  tasks,
  loading,
  error,
  saving,
  onCreate,
  onCreateTemplate,
  onEdit,
  onDelete,
  onReorder,
}: CategoryManagerDialogProps) {
  const { t } = useAppTranslation();
  // A dragged order is shown at once and dropped as soon as the saved list (or
  // a failure) comes back, so a slow command never snaps the cards around.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Hit counts come from the shared task snapshot; the backend is not asked for
  // a per-category tally.
  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      if (task.category) counts[task.category] = (counts[task.category] ?? 0) + 1;
    }
    return counts;
  }, [tasks]);

  const ordered = useMemo(() => {
    if (!pendingOrder) return categories;
    const byId = new Map(categories.map((category) => [category.id, category]));
    const next: MoinCategory[] = [];
    for (const id of pendingOrder) {
      const category = byId.get(id);
      if (category) next.push(category);
    }
    return next.length === categories.length ? next : categories;
  }, [categories, pendingOrder]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = ordered.map((category) => category.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setPendingOrder(next);
    void onReorder(next).finally(() => setPendingOrder(null));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="flex-row items-start justify-between gap-3 border-b px-5 py-4 pr-10">
          <div className="space-y-1">
            <DialogTitle>{t("moin.category.title")}</DialogTitle>
            <DialogDescription>{t("moin.category.subtitle")}</DialogDescription>
          </div>
          <Button type="button" size="sm" disabled={loading || saving} onClick={onCreate}>
            <Plus />
            {t("moin.category.new")}
          </Button>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <p role="alert" className="text-destructive mb-3 text-sm">
              {t(error)}
            </p>
          )}

          {loading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 rounded-lg border py-10 text-sm">
              <LoaderCircle className="size-4 animate-spin" />
              {t("moin.common.loading")}
            </div>
          ) : categories.length === 0 ? (
            <div className="flex flex-col gap-3 rounded-lg border border-dashed p-5">
              <div className="space-y-1 text-center">
                <p className="font-medium">{t("moin.category.empty")}</p>
                <p className="text-muted-foreground text-sm">
                  {t("moin.category.emptyDescription")}
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {TEMPLATES.map((template) => (
                  <div
                    key={template.id}
                    className="bg-card flex min-w-0 flex-col gap-2 rounded-lg border p-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: template.color }}
                      />
                      <span className="truncate text-sm font-medium">
                        {t(`moin.category.defaults.${template.id}`)}
                      </span>
                    </div>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {template.exts.map((ext) => `.${ext}`).join(", ")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-auto"
                      disabled={saving}
                      onClick={() =>
                        onCreateTemplate({
                          id: template.id,
                          name: template.name,
                          color: template.color,
                          icon: null,
                          hidden_from_all: false,
                          save_dir: null,
                          incomplete_dir: null,
                          sources: [],
                          triggers: [{ type: "extension", exts: template.exts }],
                          order: template.order,
                        })
                      }
                    >
                      {t("moin.common.add")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={ordered.map((category) => category.id)}
                strategy={rectSortingStrategy}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {ordered.map((category) => (
                    <CategoryCard
                      key={category.id}
                      category={category}
                      taskCount={taskCounts[category.id] ?? 0}
                      disabled={saving}
                      onEdit={() => onEdit(category)}
                      onDelete={() => onDelete(category)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
