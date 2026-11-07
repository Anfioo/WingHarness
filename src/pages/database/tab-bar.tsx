// The tab strip of a data source window: one tab per open query file and one
// per open table, plus the actions that create, close and reopen them.
//
// The strip keeps no state of its own. Every tab it shows comes from the window
// store and every change it makes goes back through one of the store's actions,
// which is also what persists `windows.json`. A second copy here could only
// drift from the one on disk.

import { FileCode, FilePlus2, FolderOpen, RotateCcw, Table2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { tabKey, useDatabaseStore } from "./store";
import { tabIcon, tabLabel } from "./tab-model";

/** The text of a rejected command, whatever shape it arrived in. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The tab strip. Tabs scroll sideways rather than wrapping, so the row keeps
 * the height the layout below it was measured against.
 */
export function TabBar({ onOpenQuery }: { onOpenQuery(): void }) {
  const { t } = useAppTranslation();

  const tabs = useDatabaseStore((state) => state.tabs);
  const active = useDatabaseStore((state) => state.active);
  const closedCount = useDatabaseStore((state) => state.closed.length);
  const select = useDatabaseStore((state) => state.select);
  const close = useDatabaseStore((state) => state.close);
  const reopenClosed = useDatabaseStore((state) => state.reopenClosed);
  const openQuery = useDatabaseStore((state) => state.openQuery);

  const newQuery = () => {
    openQuery().catch((error: unknown) => toast.error(failureText(error)));
  };

  const reopen = () => {
    reopenClosed().catch((error: unknown) => toast.error(failureText(error)));
  };

  // The store closes one tab at a time; the bulk menu items are that, repeated.
  // `tabs` is this render's snapshot, and its keys stay valid while the loop
  // runs, so closing through it visits every tab exactly once.
  const closeOthers = (keep: string) => {
    for (const tab of tabs) {
      const key = tabKey(tab);
      if (key !== keep) close(key);
    }
  };

  const closeAll = () => {
    for (const tab of tabs) close(tabKey(tab));
  };

  return (
    <div className="bg-muted/40 flex shrink-0 items-stretch gap-1 border-b px-1 py-1">
      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const key = tabKey(tab);
          const current = key === active;
          const label = tabLabel(tab, t);
          const Icon = tabIcon(tab) === "file-code" ? FileCode : Table2;

          return (
            <ContextMenu key={key}>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    "flex shrink-0 items-center rounded-md text-xs",
                    current ? "bg-background shadow-sm" : "hover:bg-accent/60"
                  )}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    close(key);
                  }}
                >
                  <button
                    type="button"
                    className="flex max-w-56 items-center gap-1.5 px-2 py-1 text-left"
                    title={label}
                    aria-current={current ? "true" : undefined}
                    onClick={() => select(key)}
                  >
                    <Icon
                      className={cn(
                        "size-3.5 shrink-0",
                        current ? "text-foreground" : "text-muted-foreground"
                      )}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    type="button"
                    className="hover:bg-accent mr-1 rounded-sm p-1"
                    aria-label={t("database.tab.close")}
                    title={t("database.tab.close")}
                    onClick={() => close(key)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              </ContextMenuTrigger>

              <ContextMenuContent>
                <ContextMenuItem onSelect={() => close(key)}>
                  {t("database.tab.close")}
                </ContextMenuItem>
                <ContextMenuItem disabled={tabs.length < 2} onSelect={() => closeOthers(key)}>
                  {t("database.tab.closeOthers")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={closeAll}>{t("database.tab.closeAll")}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={closedCount === 0} onSelect={reopen}>
                  {t("database.tab.reopen")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 pl-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("database.workspace.newQuery")}
          title={t("database.workspace.newQuery")}
          onClick={newQuery}
        >
          <FilePlus2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("database.workspace.openQuery")}
          title={t("database.workspace.openQuery")}
          onClick={onOpenQuery}
        >
          <FolderOpen />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={closedCount === 0}
          aria-label={t("database.tab.reopen")}
          title={t("database.tab.reopen")}
          onClick={reopen}
        >
          <RotateCcw />
        </Button>
      </div>
    </div>
  );
}
