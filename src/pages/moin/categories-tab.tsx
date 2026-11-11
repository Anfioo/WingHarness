// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useMemo, useState } from "react";
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
import { toast } from "sonner";
import type { MoinCategory } from "@/commands";
import { CategoryCard, categoryLabel } from "@/components/moin/category-card";
import { CategoryEditor } from "@/components/moin/category-editor";
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
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMoinCategories } from "@/hooks/use-moin-categories";
import { useMoinTasks } from "@/hooks/use-moin-tasks";

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

/**
 * Category grid: sortable cards, the create / edit drawer and the delete
 * confirmation. Everything mutates through `useMoinCategories`, so the saved
 * list — not a local copy — is what the grid renders.
 */
export default function CategoriesTab() {
  const { t } = useAppTranslation();
  const { categories, loading, error, create, update, remove, reorder } = useMoinCategories();
  const { tasks } = useMoinTasks();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MoinCategory | null>(null);
  const [deleting, setDeleting] = useState<MoinCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  // The list as it was when a save started: the drawer only closes once the
  // hook swaps in the saved list, so a rejected write keeps the draft open.
  const [pendingSave, setPendingSave] = useState<MoinCategory[] | null>(null);

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

  // A dragged order is shown at once and dropped as soon as the saved list (or
  // a failure) comes back, so a slow command never snaps the cards around.
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

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (category: MoinCategory) => {
    setEditing(category);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(null);
    setPendingSave(null);
  };

  // `create` / `update` resolve even when the command is rejected — the hook
  // turns that into `error` — so the saved list itself is the success signal.
  useEffect(() => {
    if (!pendingSave || categories === pendingSave) return;
    setEditorOpen(false);
    setEditing(null);
    setPendingSave(null);
    toast.success(t("moin.category.saved"));
  }, [categories, pendingSave, t]);

  const submit = async (category: MoinCategory) => {
    setSaving(true);
    setPendingSave(categories);
    try {
      if (editing) {
        await update(category);
      } else {
        await create(category);
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;
    setSaving(true);
    try {
      await remove(target.id);
    } finally {
      setSaving(false);
      setDeleting(null);
    }
  };

  const createTemplate = async (template: (typeof TEMPLATES)[number]) => {
    setSaving(true);
    try {
      await create({
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
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = ordered.map((category) => category.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setPendingOrder(next);
    void reorder(next).finally(() => setPendingOrder(null));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-medium">{t("moin.category.title")}</h2>
          <p className="text-muted-foreground text-sm">{t("moin.category.subtitle")}</p>
        </div>
        <Button type="button" size="sm" disabled={loading || saving} onClick={openCreate}>
          <Plus />
          {t("moin.category.new")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-sm">
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
            <p className="text-muted-foreground text-sm">{t("moin.category.emptyDescription")}</p>
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
                  onClick={() => void createTemplate(template)}
                >
                  {t("moin.common.add")}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={ordered.map((category) => category.id)}
            strategy={rectSortingStrategy}
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {ordered.map((category) => (
                <CategoryCard
                  key={category.id}
                  category={category}
                  taskCount={taskCounts[category.id] ?? 0}
                  disabled={saving}
                  onEdit={() => openEdit(category)}
                  onDelete={() => setDeleting(category)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <CategoryEditor
        open={editorOpen}
        category={editing}
        categories={categories}
        saving={saving}
        onOpenChange={(open) => (open ? setEditorOpen(true) : closeEditor())}
        onSubmit={(category) => void submit(category)}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("moin.common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? t("moin.category.deleteConfirm", { name: categoryLabel(deleting, t) })
                : ""}{" "}
              {t("moin.category.deleteUncategorized")} {t("moin.common.confirmDelete")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t("moin.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={() => void confirmDelete()}>
              {t("moin.common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
