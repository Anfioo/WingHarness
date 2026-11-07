import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Database as DatabaseIcon,
  Loader2,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  dbSourceList,
  dbSourceSave,
  dbSourceSetPassword,
  dbSourceTest,
  databaseErrorCode,
} from "@/commands";
import type { DataSource, DataSourceView, DbColor } from "@/commands";
import { ProjectPicker } from "@/components/project-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { openDatabaseWindow } from "@/lib/database-windows";
import { SourceDialog, asSource } from "./source-dialog";

const COLOR_DOTS: Record<DbColor, string> = {
  red: "#e5534b",
  orange: "#e8833a",
  yellow: "#e3b341",
  green: "#3fb950",
  blue: "#4c8eda",
  violet: "#a371f7",
};

/**
 * Hides the password of a URL-only data source. The full URL is never shown:
 * it is the one field that can carry a credential.
 */
function maskedTarget(source: DataSource): string {
  if (source.driver === "sqlite") return source.file ?? "";
  if (source.urlOnly) {
    return source.url.replace(/:\/\/([^:/@]+):[^@]*@/, "://$1:***@");
  }
  const host = source.port === null ? source.host : `${source.host}:${source.port}`;
  const database = source.database ? `/${source.database}` : "";
  return `${source.user ? `${source.user}@` : ""}${host}${database}`;
}

export default function DatabasePage() {
  const { t } = useAppTranslation();

  const [sources, setSources] = useState<DataSourceView[] | null>(null);
  const [projectRoot, setProjectRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DataSourceView | null>(null);
  const [deleting, setDeleting] = useState(false);

  const describeFailure = useCallback(
    (failure: unknown) => {
      const code = databaseErrorCode(failure);
      if (code) {
        return t(`database.error.${code}`, {
          defaultValue: (failure as { message: string }).message,
        });
      }
      return failure instanceof Error ? failure.message : String(failure);
    },
    [t]
  );

  const load = useCallback(
    async (announce = false) => {
      setLoading(true);
      setError(null);
      try {
        const loaded = await dbSourceList();
        setSources(loaded);
        if (announce) {
          toast.success(t("database.toast.reloaded"));
        }
      } catch (failure) {
        setError(describeFailure(failure));
      } finally {
        setLoading(false);
      }
    },
    [describeFailure, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The page's data sources are app-wide, but a relative SQLite path in one of
  // them resolves against the project in front of the user, so switching project
  // is a reload.
  const handleProjectChange = useCallback(
    (next: string) => {
      setProjectRoot(next);
      void load();
    },
    [load]
  );

  const list = useMemo(() => sources ?? [], [sources]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (source) =>
        source.name.toLowerCase().includes(needle) ||
        source.driver.toLowerCase().includes(needle) ||
        maskedTarget(source).toLowerCase().includes(needle)
    );
  }, [list, query]);

  const handleOpen = async (source: DataSourceView) => {
    try {
      await openDatabaseWindow(source.id, source.name, projectRoot.trim());
    } catch (failure) {
      toast.error(
        t("database.error.openFailed", {
          error: describeFailure(failure),
        })
      );
    }
  };

  const handleSaved = async (source: DataSource, password: string) => {
    const next: DataSource[] = list.some((entry) => entry.id === source.id)
      ? list.map((entry) => (entry.id === source.id ? source : asSource(entry)))
      : [...list.map(asSource), source];
    try {
      await dbSourceSave(next);
      if (password) {
        await dbSourceSetPassword(source.id, password, source.savePassword);
      }
      await load();
    } catch (failure) {
      toast.error(
        t("database.error.saveFailed", {
          error: describeFailure(failure),
        })
      );
      throw failure;
    }
  };

  const handleDuplicate = async (source: DataSourceView) => {
    setBusyId(source.id);
    const copy: DataSource = {
      ...asSource(source),
      id: crypto.randomUUID(),
      name: t("database.form.duplicateName", {
        name: source.name,
      }),
    };
    try {
      await dbSourceSave([...list.map(asSource), copy]);
      await load();
    } catch (failure) {
      toast.error(
        t("database.error.saveFailed", {
          error: describeFailure(failure),
        })
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = async (source: DataSourceView) => {
    setBusyId(source.id);
    try {
      const version = await dbSourceTest(asSource(source), null);
      toast.success(t("database.test.success", { version }));
    } catch (failure) {
      toast.error(
        t("database.test.failed", {
          error: describeFailure(failure),
        })
      );
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await dbSourceSave(list.filter((entry) => entry.id !== pendingDelete.id).map(asSource));
      toast.success(t("database.toast.deleted", { name: pendingDelete.name }));
      setPendingDelete(null);
      await load();
    } catch (failure) {
      toast.error(
        t("database.error.deleteFailed", {
          error: describeFailure(failure),
        })
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleEdit = (source: DataSourceView) => {
    setEditing(asSource(source));
    setFormOpen(true);
  };

  const handleCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const hasSources = list.length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("database.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("database.subtitle")}</p>
        </div>
        <Button onClick={handleCreate}>
          <Plus />
          {t("database.action.create")}
        </Button>
      </header>

      <ProjectPicker value={projectRoot} onChange={handleProjectChange} />

      {hasSources && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-md">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              className="pr-8 pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("database.search.placeholder")}
              aria-label={t("database.search.placeholder")}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
                aria-label={t("database.search.clear")}
                onClick={() => setQuery("")}
              >
                <X />
              </Button>
            )}
          </div>

          <span className="text-muted-foreground text-xs">
            {t("database.list.count", { count: list.length })}
          </span>

          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={loading}
            onClick={() => void load(true)}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("database.action.refresh")}
          </Button>
        </div>
      )}

      {loading && !sources ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm">
          <Loader2 className="size-6 animate-spin" />
          {t("database.loading")}
        </div>
      ) : error && !sources ? (
        <div className="border-destructive/40 bg-destructive/5 flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center">
          <AlertTriangle className="text-destructive size-7" />
          <p className="text-sm font-medium">{t("database.error.loadFailed")}</p>
          <p className="text-muted-foreground max-w-md text-xs break-words">{error}</p>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("database.action.retry")}
          </Button>
        </div>
      ) : !hasSources ? (
        <div className="border-border text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center text-sm">
          <DatabaseIcon className="size-8" />
          <p className="text-foreground font-medium">{t("database.empty.title")}</p>
          <p className="max-w-md">{t("database.empty.description")}</p>
          <Button variant="outline" onClick={handleCreate}>
            <Plus />
            {t("database.empty.action")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <Search className="size-6" />
          <p className="text-foreground font-medium">{t("database.list.noResults")}</p>
          <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
            {t("database.search.clear")}
          </Button>
        </div>
      ) : (
        <ul className="divide-border divide-y rounded-lg border">
          {filtered.map((source) => (
            <li key={source.id} className="hover:bg-accent/40 flex items-center gap-3 px-3 py-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: source.color ? COLOR_DOTS[source.color] : undefined }}
                aria-hidden
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => void handleOpen(source)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{source.name}</span>
                  <Badge variant="secondary">{t(`database.driver.${source.driver}`)}</Badge>
                  <Badge variant="outline">
                    {source.global ? t("database.list.global") : t("database.list.project")}
                  </Badge>
                  {source.connected && <Badge>{t("database.list.connected")}</Badge>}
                </div>
                <div className="text-muted-foreground truncate font-mono text-xs">
                  {maskedTarget(source)}
                </div>
              </button>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busyId === source.id}
                  aria-label={t("database.action.test")}
                  title={t("database.action.test")}
                  onClick={() => void handleTest(source)}
                >
                  {busyId === source.id ? <Loader2 className="animate-spin" /> : <PlugZap />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("database.action.edit")}
                  title={t("database.action.edit")}
                  onClick={() => handleEdit(source)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busyId === source.id}
                  aria-label={t("database.action.duplicate")}
                  title={t("database.action.duplicate")}
                  onClick={() => void handleDuplicate(source)}
                >
                  <Copy />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("database.action.delete")}
                  title={t("database.action.delete")}
                  onClick={() => setPendingDelete(source)}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && sources && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="ghost" size="xs" disabled={loading} onClick={() => void load()}>
            {t("database.action.retry")}
          </Button>
        </div>
      )}

      <SourceDialog
        open={formOpen}
        source={editing}
        hasProject={projectRoot.trim().length > 0}
        onOpenChange={setFormOpen}
        onSaved={handleSaved}
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
              {t("database.delete.title")}
            </DialogTitle>
            <DialogDescription>
              {t("database.delete.description", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>
              {t("database.form.cancel")}
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t("database.action.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
