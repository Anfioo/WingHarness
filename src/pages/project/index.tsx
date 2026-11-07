import { useCallback, useEffect, useMemo, useState } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Clock,
  FolderGit2,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  openWorkspaceTarget,
  pathsExist,
  projectForget,
  projectRecentList,
  projectRemember,
  type ProjectEntry,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  openProjectWindow,
  openProjectWindowLabels,
  projectWindowLabel,
} from "@/lib/project-windows";
import { cn } from "@/lib/utils";

/** Epoch milliseconds as a locale-aware "3 hours ago". */
function relativeTime(ms: number, language: string): string {
  if (!Number.isFinite(ms)) return "";
  const deltaSeconds = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (abs < 60) return format.format(deltaSeconds, "second");
  if (abs < 3600) return format.format(Math.round(deltaSeconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(deltaSeconds / 3600), "hour");
  if (abs < 86_400 * 30) return format.format(Math.round(deltaSeconds / 86_400), "day");
  if (abs < 86_400 * 365) return format.format(Math.round(deltaSeconds / (86_400 * 30)), "month");
  return format.format(Math.round(deltaSeconds / (86_400 * 365)), "year");
}

/**
 * The project picker: the app's start page. Picking a folder opens it in a
 * window of its own (`@/lib/project-windows`), so this route never shows a
 * project itself and carries no `?path=` — several projects can be open at
 * once, each in its own window.
 *
 * The recent list is the backend's (`projectRecentList`), not localStorage:
 * `projectRemember` records an open and this page re-reads it.
 */
export default function ProjectPage() {
  const { t, language } = useAppTranslation();

  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<ProjectEntry[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [openLabels, setOpenLabels] = useState<Set<string>>(new Set());

  const [pathInput, setPathInput] = useState("");
  const [openBusy, setOpenBusy] = useState(false);

  const loadRecents = useCallback(() => {
    void projectRecentList()
      .then(setRecents)
      .catch((error: unknown) => {
        console.error("Failed to load recent projects:", error);
      });
  }, []);

  // Which projects already have a window open, in the same identity the window
  // labels use. Nothing announces a window closing, so the list is re-scanned
  // whenever this window comes back to the front — the only moment it can change
  // without this page doing it.
  const refreshOpenLabels = useCallback(() => {
    void openProjectWindowLabels().then((labels) => setOpenLabels(new Set(labels)));
  }, []);

  useEffect(() => {
    loadRecents();
    refreshOpenLabels();
    window.addEventListener("focus", refreshOpenLabels);
    document.addEventListener("visibilitychange", refreshOpenLabels);
    return () => {
      window.removeEventListener("focus", refreshOpenLabels);
      document.removeEventListener("visibilitychange", refreshOpenLabels);
    };
  }, [loadRecents, refreshOpenLabels]);

  // A recent whose folder has since been deleted cannot be opened.
  useEffect(() => {
    if (recents.length === 0) {
      setMissing(new Set());
      return;
    }
    let cancelled = false;
    void pathsExist(recents.map((project) => project.path))
      .then((flags) => {
        if (cancelled) return;
        const next = new Set<string>();
        recents.forEach((project, index) => {
          if (!flags[index]) next.add(project.path);
        });
        setMissing(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recents]);

  const openProject = useCallback(
    async (rawPath: string) => {
      const path = rawPath.trim();
      if (!path || openBusy) return;
      if (missing.has(path)) {
        toast.error(t("projectHome.toast.missingFolder"));
        return;
      }
      setOpenBusy(true);
      try {
        await projectRemember(path);
        await openProjectWindow(path);
        loadRecents();
        refreshOpenLabels();
      } catch (error) {
        toast.error(t("projectHome.toast.openFailed"), { description: String(error) });
        console.error("Failed to open the project:", error);
      } finally {
        setOpenBusy(false);
      }
    },
    [loadRecents, missing, openBusy, refreshOpenLabels, t]
  );

  const browseForOpen = useCallback(async () => {
    const dir = await pickDirectory({ directory: true });
    if (typeof dir === "string") setPathInput(dir);
  }, []);

  const openTypedPath = useCallback(async () => {
    const path = pathInput.trim();
    if (!path) return;
    const [exists] = await pathsExist([path]);
    if (!exists) {
      toast.error(t("projectHome.toast.missingFolder"));
      return;
    }
    await openProject(path);
  }, [openProject, pathInput, t]);

  const removeRecent = useCallback(
    async (path: string) => {
      try {
        await projectForget(path);
        loadRecents();
      } catch (error) {
        toast.error(t("projectHome.recent.removeFailed"), { description: String(error) });
        console.error("Failed to forget the project:", error);
      }
    },
    [loadRecents, t]
  );

  const revealPath = useCallback(
    async (path: string) => {
      try {
        await openWorkspaceTarget(path, "explorer");
      } catch (error) {
        toast.error(t("projectHome.recent.revealFailed"), { description: String(error) });
        console.error("Failed to reveal the project:", error);
      }
    },
    [t]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recents;
    return recents.filter(
      (project) =>
        project.path.toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle)
    );
  }, [recents, query]);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="animate-fade-in w-full px-6 py-10">
        <header className="mb-6 flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl">
            <FolderGit2 className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-primary text-xl font-semibold tracking-tight">
              {t("projectHome.header.title")}
            </h1>
            <p className="text-muted-foreground text-sm">{t("projectHome.header.tagline")}</p>
          </div>
        </header>

        <section className="animate-slide-up border-border bg-card shadow-soft max-w-xl rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-3">
            <span className="bg-primary/15 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
              <FolderOpen className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-medium">{t("projectHome.open.title")}</h2>
              <p className="text-muted-foreground text-xs">{t("projectHome.open.hint")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void openTypedPath();
              }}
              placeholder={t("projectHome.open.pathPlaceholder")}
              aria-label={t("projectHome.open.pathLabel")}
              className="h-8 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void browseForOpen()}>
                {t("projectHome.open.browse")}
              </Button>
              <Button
                size="sm"
                onClick={() => void openTypedPath()}
                disabled={!pathInput.trim() || openBusy}
              >
                {openBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {openBusy ? t("projectHome.open.opening") : t("projectHome.open.open")}
              </Button>
            </div>
          </div>
        </section>

        <section className="animate-slide-up border-border bg-card shadow-soft mt-3 rounded-lg border">
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Clock className="text-muted-foreground size-4" />
            <h2 className="text-sm font-medium">{t("projectHome.recent.title")}</h2>
            <span className="text-faint text-xs">{visible.length}</span>
            <div className="relative ml-auto w-52">
              <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("projectHome.recent.searchPlaceholder")}
                aria-label={t("projectHome.recent.searchLabel")}
                className="h-7 pl-8 text-xs"
              />
            </div>
          </div>

          {recents.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                <FolderGit2 className="size-6" />
              </span>
              <div>
                <p className="text-sm font-medium">{t("projectHome.recent.emptyTitle")}</p>
                <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
                  {t("projectHome.recent.emptyDescription")}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => void browseForOpen()}>
                {t("projectHome.recent.emptyOpen")}
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">
              {t("projectHome.recent.noMatch", { query })}
            </p>
          ) : (
            <ul className="p-1">
              {visible.map((project) => (
                <RecentRow
                  key={project.path}
                  project={project}
                  openedAt={relativeTime(project.openedAt, language)}
                  isOpen={openLabels.has(projectWindowLabel(project.path))}
                  isMissing={missing.has(project.path)}
                  labels={{
                    alreadyOpen: t("projectHome.recent.alreadyOpen"),
                    missing: t("projectHome.recent.missing"),
                    menuAria: t("projectHome.recent.menuAria", { name: project.name }),
                    open: t("projectHome.recent.open"),
                    focus: t("projectHome.recent.focus"),
                    reveal: t("projectHome.recent.reveal"),
                    remove: t("projectHome.recent.remove"),
                  }}
                  onOpen={() => void openProject(project.path)}
                  onReveal={() => void revealPath(project.path)}
                  onRemove={() => void removeRecent(project.path)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

interface RecentRowLabels {
  alreadyOpen: string;
  missing: string;
  menuAria: string;
  open: string;
  focus: string;
  reveal: string;
  remove: string;
}

function RecentRow({
  project,
  openedAt,
  isOpen,
  isMissing,
  labels,
  onOpen,
  onReveal,
  onRemove,
}: {
  project: ProjectEntry;
  openedAt: string;
  isOpen: boolean;
  isMissing: boolean;
  labels: RecentRowLabels;
  onOpen: () => void;
  onReveal: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="group hover:bg-accent flex items-center gap-3 rounded-md px-2 py-1.5">
      <button
        type="button"
        onClick={onOpen}
        disabled={isMissing}
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed"
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            isMissing ? "bg-muted text-faint" : "bg-primary/10 text-primary"
          )}
        >
          <FolderGit2 className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{project.name || project.path}</span>
            {isOpen ? (
              <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
                {labels.alreadyOpen}
              </Badge>
            ) : null}
          </span>
          <span className="text-faint block truncate font-mono text-[11px]" title={project.path}>
            {project.path}
          </span>
        </span>
      </button>

      <span className="text-faint shrink-0 text-xs">
        {isMissing ? (
          <span className="text-destructive flex items-center gap-1">
            <AlertTriangle className="size-3" />
            {labels.missing}
          </span>
        ) : (
          openedAt
        )}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={labels.menuAria}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={onOpen} disabled={isMissing}>
            <FolderGit2 className="size-3.5" />
            {isOpen ? labels.focus : labels.open}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onReveal} disabled={isMissing}>
            <FolderOpen className="size-3.5" />
            {labels.reveal}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="size-3.5" />
            {labels.remove}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
