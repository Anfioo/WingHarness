import { Fragment, useState } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical, Pin, RefreshCw, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { openPath, type TrayApp } from "@/commands";
import { TrayAppIcon } from "@/components/tray-apps/app-icon";
import { TrayMenuPreview } from "@/components/tray-apps/menu-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTrayAppsPage } from "@/hooks/use-tray-apps-page";
import { cn } from "@/lib/utils";

/**
 * The tray's second-level menu settings, as a tab of the Scoop page: which
 * Scoop apps it offers, which of them sit at the top, and the order they are
 * drawn in.
 *
 * The tray reads these lists whenever its popup opens, so every change is saved
 * as it is made and the preview on the right is the same component tree the
 * popup draws. Dragging a row is the order; dropping across the divider pins or
 * unpins that app. The list is a dnd-kit sortable, so the rows part to show
 * where the dragged one will land.
 */
export function ScoopTrayPanel() {
  const { t } = useAppTranslation();
  const page = useTrayAppsPage();
  const [launching, setLaunching] = useState<string | null>(null);

  const launch = async (app: TrayApp) => {
    setLaunching(app.id);
    try {
      await openPath(app.path);
    } catch (cause) {
      toast.error(t("trayApps.launchFailed"), { description: String(cause) });
    } finally {
      setLaunching(null);
    }
  };

  const pinnedIds = new Set((page.view?.pinned ?? []).map((id) => id.toLowerCase()));
  const firstUnpinned = page.filtered.findIndex((app) => !pinnedIds.has(app.id.toLowerCase()));
  const pinnedCount = firstUnpinned === -1 ? page.filtered.length : firstUnpinned;

  // A filtered list is a different sequence from the saved one, so dragging is
  // off until the search is cleared: dropping then has one unambiguous meaning.
  const sortDisabled = page.query.trim().length > 0;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const ids = page.filtered.map((app) => app.id);
    const oldIndex = ids.indexOf(String(active.id));
    const overIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || overIndex < 0) return;

    const next = arrayMove(ids, oldIndex, overIndex);
    const draggedIndex = next.indexOf(String(active.id));
    const remaining = next.filter((id) => id !== active.id);
    // Insert before the row that follows the drop position, or at the end.
    page.move(String(active.id), remaining[draggedIndex] ?? null);
  };

  const nothingSaved =
    !page.view ||
    (page.view.pinned.length === 0 &&
      page.view.hidden.length === 0 &&
      page.view.order.length === 0);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      <div className="space-y-0.5">
        <p className="text-muted-foreground text-sm">{t("trayApps.subtitle")}</p>
        <p className="text-muted-foreground/70 text-xs">{t("trayApps.dragHint")}</p>
      </div>

      {page.error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {t("trayApps.loadFailed")} {page.error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="border-border flex min-h-0 flex-col overflow-hidden rounded-xl border">
          <div className="border-border flex flex-wrap items-center gap-2 border-b p-3">
            <div className="relative min-w-40 flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                value={page.query}
                onChange={(event) => page.setQuery(event.target.value)}
                placeholder={t("trayApps.search")}
                className="pl-8"
              />
            </div>
            <span className="text-muted-foreground text-xs">
              {t("trayApps.summary", {
                showing: page.counts.showing,
                total: page.counts.total,
                pinned: page.counts.pinned,
                hidden: page.counts.hidden,
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={nothingSaved}
              onClick={page.reset}
              title={t("trayApps.reset")}
            >
              <RotateCcw className="size-4" />
              {t("trayApps.reset")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={page.loading}
              onClick={() => void page.refresh()}
              title={t("trayApps.refresh")}
            >
              <RefreshCw className={cn("size-4", page.loading && "animate-spin")} />
              {t("trayApps.refresh")}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {page.loading && page.view === null ? (
              <div className="space-y-1 p-2">
                {[0, 1, 2, 3, 4].map((row) => (
                  <Skeleton key={row} className="h-11 w-full rounded-md" />
                ))}
              </div>
            ) : page.filtered.length === 0 ? (
              <EmptyState query={page.query} folder={page.view?.folder ?? ""} />
            ) : (
              <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={page.filtered.map((app) => app.id)}
                  strategy={verticalListSortingStrategy}
                  disabled={sortDisabled}
                >
                  <div className="p-1">
                    {page.filtered.map((app, index) => (
                      <Fragment key={app.id}>
                        {index === pinnedCount &&
                          pinnedCount > 0 &&
                          pinnedCount < page.filtered.length && (
                            <div className="bg-border mx-2 my-1 h-px" />
                          )}
                        <SettingsRow
                          app={app}
                          pinned={pinnedIds.has(app.id.toLowerCase())}
                          hidden={(page.view?.hidden ?? []).includes(app.id)}
                          launching={launching === app.id}
                          sortDisabled={sortDisabled}
                          onTogglePin={() => page.togglePin(app)}
                          onToggleHide={() => page.toggleHide(app)}
                          onLaunch={() => void launch(app)}
                        />
                      </Fragment>
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          <footer className="border-border text-muted-foreground shrink-0 border-t px-3 py-2 text-[11px]">
            {page.view?.folder ? (
              <span className="block truncate" title={page.view.folder}>
                {t("trayApps.folder", { folder: page.view.folder })}
              </span>
            ) : (
              <span className="block">{t("trayApps.noFolder")}</span>
            )}
          </footer>
        </section>

        <section className="border-border flex min-h-0 flex-col overflow-hidden rounded-xl border">
          <header className="border-border space-y-0.5 border-b px-4 py-2">
            <h2 className="text-sm font-semibold">{t("trayApps.preview.title")}</h2>
            <p className="text-muted-foreground text-xs">{t("trayApps.preview.description")}</p>
          </header>
          <div className="min-h-0 flex-1 p-3">
            <TrayMenuPreview curated={page.curated} onLaunch={(app) => void launch(app)} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** One app in the list: reorder it, pin it, hide it, or open it to check it runs. */
function SettingsRow({
  app,
  pinned,
  hidden,
  launching,
  sortDisabled,
  onTogglePin,
  onToggleHide,
  onLaunch,
}: {
  app: TrayApp;
  pinned: boolean;
  hidden: boolean;
  launching: boolean;
  sortDisabled: boolean;
  onTogglePin: () => void;
  onToggleHide: () => void;
  onLaunch: () => void;
}) {
  const { t } = useAppTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: app.id,
    disabled: sortDisabled,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "border-border/60 bg-background flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0",
        hidden && "opacity-55",
        isDragging && "bg-card relative z-10 opacity-65"
      )}
    >
      <button
        type="button"
        aria-label={t("trayApps.action.drag")}
        title={sortDisabled ? t("trayApps.action.dragDisabled") : t("trayApps.action.drag")}
        disabled={sortDisabled}
        {...attributes}
        {...listeners}
        className={cn(
          "text-muted-foreground/60 hover:text-foreground touch-none rounded p-0.5",
          sortDisabled ? "cursor-not-allowed opacity-40" : "cursor-grab active:cursor-grabbing"
        )}
      >
        <GripVertical className="size-4" />
      </button>

      <button
        type="button"
        onClick={onLaunch}
        title={t("trayApps.action.launch", { name: app.displayName })}
        disabled={launching}
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-progress"
      >
        <TrayAppIcon app={app} size={28} />
        <span
          className={cn(
            "truncate text-sm font-medium",
            hidden && "decoration-muted-foreground/40 line-through"
          )}
        >
          {app.displayName}
        </span>
      </button>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onTogglePin}
        title={pinned ? t("trayApps.action.unpin") : t("trayApps.action.pin")}
        className={cn(pinned && "text-amber-500")}
      >
        <Pin className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onToggleHide}
        title={hidden ? t("trayApps.action.show") : t("trayApps.action.hide")}
      >
        {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

function EmptyState({ query, folder }: { query: string; folder: string }) {
  const { t } = useAppTranslation();

  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <p className="text-sm">
        {query ? t("trayApps.empty.search", { query }) : t("trayApps.empty.none")}
      </p>
      {!query && (
        <p className="text-muted-foreground/70 text-xs leading-relaxed">
          {folder ? t("trayApps.empty.hint", { folder }) : t("trayApps.noFolder")}
        </p>
      )}
    </div>
  );
}
