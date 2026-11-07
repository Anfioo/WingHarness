// The project page's database panel: the data sources of this project, one
// collapsible group each.
//
// It is drawn over codelet's side bar by `WorkbenchSurface`, like the commit
// view — the shell has no idea it is there. Everything under it comes from the
// project workspace in `<project root>/.wh/db`; none of these sources exist for
// the database page.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Database as DatabaseIcon,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { dbProjectQueries } from "@/commands";
import type { DataSource, DataSourceView } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { navigateApp } from "@/lib/router";
import { useProjectDb } from "@/features/database/project/view-store";
import {
  deleteProjectSource,
  duplicateProjectSource,
  saveProjectSource,
} from "@/features/database/project/source-actions";
import { SourceGroup } from "@/features/database/project/source-group";
import { OpenQueryDialog } from "@/pages/database/tree-toolbar";
import { SourceDialog } from "@/pages/database/source-dialog";
import { asSource } from "@/pages/database/model";

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectDatabaseSidebar(): ReactNode {
  const { t } = useAppTranslation();

  const sources = useProjectDb((state) => state.sources);
  const status = useProjectDb((state) => state.sourcesStatus);
  const error = useProjectDb((state) => state.sourcesError);
  const noProject = useProjectDb((state) => state.noProject);
  const loadSources = useProjectDb((state) => state.loadSources);
  const openQuery = useProjectDb((state) => state.openQuery);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DataSourceView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openQueryFor, setOpenQueryFor] = useState<string | null>(null);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const toggle = (sourceId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const createSource = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const editSource = (source: DataSourceView) => {
    setEditing(asSource(source));
    setFormOpen(true);
  };

  const saved = useCallback(
    async (source: DataSource, password: string) => {
      try {
        await saveProjectSource(useProjectDb.getState().sources, source, password);
        await loadSources();
      } catch (failure) {
        toast.error(t("projectDb.error.saveSources", { error: failureText(failure) }));
        throw failure;
      }
    },
    [loadSources, t]
  );

  const duplicate = async (source: DataSourceView) => {
    try {
      await duplicateProjectSource(
        useProjectDb.getState().sources,
        source,
        t("database.form.duplicateName", { name: source.name })
      );
      await loadSources();
    } catch (failure) {
      toast.error(t("projectDb.error.saveSources", { error: failureText(failure) }));
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      await deleteProjectSource(useProjectDb.getState().sources, target.id);
      setPendingDelete(null);
      setExpanded((current) => {
        if (!current.has(target.id)) return current;
        const next = new Set(current);
        next.delete(target.id);
        return next;
      });
      await loadSources();
    } catch (failure) {
      toast.error(t("projectDb.error.saveSources", { error: failureText(failure) }));
    } finally {
      setDeleting(false);
    }
  };

  const newQuery = (sourceId: string) => {
    openQuery(sourceId).catch((failure: unknown) => toast.error(failureText(failure)));
  };

  const chooseQuery = async (sourceId: string, name: string) => {
    await openQuery(sourceId, name);
  };

  const loading = status === "loading";

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {t("projectDb.panel.title")}
        </span>
        {sources.length > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("projectDb.panel.collapseAll")}
            title={t("projectDb.panel.collapseAll")}
            onClick={() => setExpanded(new Set())}
          >
            <ChevronDown />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={loading || noProject}
          aria-label={t("projectDb.panel.refresh")}
          title={t("projectDb.panel.refresh")}
          onClick={() => void loadSources()}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={noProject}
          aria-label={t("projectDb.panel.addSource")}
          title={t("projectDb.panel.addSource")}
          onClick={createSource}
        >
          <Plus />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {noProject ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 p-6 text-center text-xs">
            <AlertTriangle className="size-6" />
            <p className="text-foreground font-medium">{t("projectDb.error.noProject")}</p>
            <Button variant="outline" size="sm" onClick={() => navigateApp("/settings")}>
              <Settings />
              {t("projectDb.error.openSettings")}
            </Button>
          </div>
        ) : loading && sources.length === 0 ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 p-6 text-xs">
            <Loader2 className="size-4 animate-spin" />
            {t("database.loading")}
          </div>
        ) : status === "error" && sources.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 p-6 text-center text-xs">
            <AlertTriangle className="text-destructive size-6" />
            <p className="text-destructive break-words whitespace-pre-wrap">
              {t("projectDb.error.loadSources", { error: error ?? "" })}
            </p>
            <Button variant="outline" size="sm" onClick={() => void loadSources()}>
              <RefreshCw />
              {t("database.action.retry")}
            </Button>
          </div>
        ) : sources.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 p-6 text-center text-xs">
            <DatabaseIcon className="size-8" />
            <div className="space-y-1">
              <p className="text-foreground font-medium">{t("projectDb.panel.emptyTitle")}</p>
              <p>{t("projectDb.panel.emptyDescription")}</p>
            </div>
            <Button variant="outline" size="sm" onClick={createSource}>
              <Plus />
              {t("projectDb.panel.addSource")}
            </Button>
          </div>
        ) : (
          <>
            {sources.map((source) => (
              <SourceGroup
                key={source.id}
                source={source}
                expanded={expanded.has(source.id)}
                onToggle={() => toggle(source.id)}
                onEdit={() => editSource(source)}
                onDuplicate={() => void duplicate(source)}
                onDelete={() => setPendingDelete(source)}
                onNewQuery={() => newQuery(source.id)}
                onOpenQuery={() => setOpenQueryFor(source.id)}
              />
            ))}
            {error && (
              <div className="border-destructive/40 bg-destructive/5 text-destructive m-2 flex flex-wrap items-start gap-2 rounded-md border px-2 py-1.5 text-[11px]">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <Button variant="ghost" size="xs" onClick={() => void loadSources()}>
                  {t("database.action.retry")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <SourceDialog
        open={formOpen}
        source={editing}
        hasProject
        scope="project"
        onOpenChange={setFormOpen}
        onSaved={saved}
      />

      <OpenQueryDialog
        open={openQueryFor !== null}
        onOpenChange={(open) => {
          if (!open) setOpenQueryFor(null);
        }}
        listFiles={dbProjectQueries}
        onChoose={(name) => {
          const sourceId = openQueryFor;
          if (!sourceId) return Promise.resolve();
          return chooseQuery(sourceId, name);
        }}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="text-destructive size-4 shrink-0" />
              {t("projectDb.source.deleteTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("projectDb.source.deleteDescription", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("database.form.cancel")}
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t("projectDb.source.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
