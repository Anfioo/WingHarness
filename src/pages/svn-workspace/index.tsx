import { useCallback, useEffect, useMemo, useState } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Clock,
  FolderOpen,
  FolderSync,
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
  configureSvnExecutable,
  openWorkspaceTarget,
  pathsExist,
  svnCheckout,
  svnInfo,
  svnWorkspaceForget,
  svnWorkspaceRecent,
  svnWorkspaceRemember,
} from "@/commands";
import { readSvnSettings } from "@/features/svn-workspace/settings";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { RecentWorkspace } from "@/lib/svn-core";
import {
  openSvnWorkspaceWindow,
  openSvnWorkspaceWindowLabels,
  svnWorkspaceWindowLabel,
} from "@/lib/svn-windows";
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

/** Last path segment, used to name a freshly checked-out working copy. */
function baseName(path: string) {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The SVN feature's page of the main window: the picker. Picking a working copy
 * opens it in a window of its own (`@/lib/svn-windows`), so this route never
 * shows a working copy itself and carries no `?path=`.
 *
 * The recent list is the engine's (`svnWorkspaceRecent`), not localStorage:
 * `svnWorkspaceRemember` records an open and this page re-reads it, the same
 * way the reference was ported to persist outside the WebView store.
 */
export default function SvnWorkspacePage() {
  const { t, language } = useAppTranslation();

  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [openLabels, setOpenLabels] = useState<Set<string>>(new Set());

  const [pathInput, setPathInput] = useState("");
  const [openBusy, setOpenBusy] = useState(false);

  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [checkoutInto, setCheckoutInto] = useState("");
  const [checkoutRevision, setCheckoutRevision] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  const [svnMissing, setSvnMissing] = useState(false);
  const [svnChecking, setSvnChecking] = useState(false);

  const loadRecents = useCallback(() => {
    void svnWorkspaceRecent()
      .then(setRecents)
      .catch((error: unknown) => {
        console.error("Failed to load recent working copies:", error);
      });
  }, []);

  // Which working copies already have a window open, in the same identity the
  // window labels use. Nothing announces a window closing, so the list is
  // re-scanned whenever this window comes back to the front — the only moment it
  // can change without this page doing it.
  const refreshOpenLabels = useCallback(() => {
    void openSvnWorkspaceWindowLabels().then((labels) => setOpenLabels(new Set(labels)));
  }, []);

  // Probe the `svn` binary once; a failure is reported as a banner with a retry.
  const probeSvn = useCallback(async () => {
    setSvnChecking(true);
    try {
      await configureSvnExecutable(readSvnSettings().svnPath.trim() || undefined);
      setSvnMissing(false);
    } catch (error) {
      console.error("SVN executable probe failed:", error);
      setSvnMissing(true);
    } finally {
      setSvnChecking(false);
    }
  }, []);

  useEffect(() => {
    loadRecents();
    refreshOpenLabels();
    void probeSvn();
    window.addEventListener("focus", refreshOpenLabels);
    document.addEventListener("visibilitychange", refreshOpenLabels);
    return () => {
      window.removeEventListener("focus", refreshOpenLabels);
      document.removeEventListener("visibilitychange", refreshOpenLabels);
    };
  }, [loadRecents, probeSvn, refreshOpenLabels]);

  // A recent whose folder has since been deleted cannot be opened.
  useEffect(() => {
    if (recents.length === 0) {
      setMissing(new Set());
      return;
    }
    let cancelled = false;
    void pathsExist(recents.map((workspace) => workspace.path))
      .then((flags) => {
        if (cancelled) return;
        const next = new Set<string>();
        recents.forEach((workspace, index) => {
          if (!flags[index]) next.add(workspace.path);
        });
        setMissing(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recents]);

  const openWorkingCopy = useCallback(
    async (rawPath: string) => {
      const path = rawPath.trim();
      if (!path || openBusy) return;
      if (missing.has(path)) {
        toast.error(t("svnWorkspace.welcome.toast.missingFolder"));
        return;
      }
      setOpenBusy(true);
      try {
        // Confirm it really is a working copy before spending a window on it.
        await svnInfo(path);
        void svnWorkspaceRemember(path).catch(() => undefined);
        await openSvnWorkspaceWindow(path);
        loadRecents();
        refreshOpenLabels();
      } catch (error) {
        toast.error(t("svnWorkspace.welcome.toast.notAWorkingCopy"), {
          description: String(error),
        });
        console.error("Failed to open the working copy:", error);
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
      toast.error(t("svnWorkspace.welcome.toast.missingFolder"));
      return;
    }
    await openWorkingCopy(path);
  }, [openWorkingCopy, pathInput, t]);

  const browseForCheckoutInto = useCallback(async () => {
    const dir = await pickDirectory({ directory: true });
    if (typeof dir === "string") setCheckoutInto(dir);
  }, []);

  const runCheckout = useCallback(async () => {
    const url = checkoutUrl.trim();
    const into = checkoutInto.trim();
    if (!url || !into || checkoutBusy) return;
    const parsed = Number.parseInt(checkoutRevision.trim(), 10);
    const revision = Number.isFinite(parsed) ? parsed : undefined;
    setCheckoutBusy(true);
    try {
      await svnCheckout(url, into, revision);
      toast.success(t("svnWorkspace.welcome.toast.checkoutDone", { name: baseName(into) }));
      await openWorkingCopy(into);
    } catch (error) {
      toast.error(t("svnWorkspace.welcome.toast.checkoutFailed"), { description: String(error) });
      console.error("Failed to check out the repository:", error);
    } finally {
      setCheckoutBusy(false);
    }
  }, [checkoutBusy, checkoutInto, checkoutRevision, checkoutUrl, openWorkingCopy, t]);

  const removeRecent = useCallback(
    async (path: string) => {
      try {
        await svnWorkspaceForget(path);
        loadRecents();
      } catch (error) {
        toast.error(t("svnWorkspace.welcome.recent.removeFailed"), { description: String(error) });
        console.error("Failed to forget the working copy:", error);
      }
    },
    [loadRecents, t]
  );

  const revealPath = useCallback(
    async (path: string) => {
      try {
        await openWorkspaceTarget(path, "explorer");
      } catch (error) {
        toast.error(t("svnWorkspace.welcome.recent.revealFailed"), { description: String(error) });
        console.error("Failed to reveal the working copy:", error);
      }
    },
    [t]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recents;
    return recents.filter((workspace) => workspace.path.toLowerCase().includes(needle));
  }, [recents, query]);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="animate-fade-in w-full px-6 py-10">
        <header className="mb-6 flex items-center gap-3">
          <span className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl">
            <FolderSync className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-primary text-xl font-semibold tracking-tight">
              {t("svnWorkspace.welcome.header.brand")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("svnWorkspace.welcome.header.tagline")}
            </p>
          </div>
        </header>

        {svnMissing ? (
          <section className="border-destructive/40 bg-destructive/5 mb-3 flex items-start gap-3 rounded-lg border p-4">
            <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-destructive text-sm font-medium">
                {t("svnWorkspace.welcome.svnMissing.title")}
              </h2>
              <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                {t("svnWorkspace.welcome.svnMissing.description")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void probeSvn()}
              disabled={svnChecking}
            >
              {svnChecking ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("svnWorkspace.welcome.svnMissing.retry")}
            </Button>
          </section>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <section className="animate-slide-up border-border bg-card shadow-soft rounded-lg border p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="bg-primary/15 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
                <FolderOpen className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-medium">{t("svnWorkspace.welcome.actions.open")}</h2>
                <p className="text-muted-foreground text-xs">
                  {t("svnWorkspace.welcome.actions.openHint")}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Input
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void openTypedPath();
                }}
                placeholder={t("svnWorkspace.welcome.openCard.pathPlaceholder")}
                aria-label={t("svnWorkspace.welcome.openCard.pathLabel")}
                className="h-8 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void browseForOpen()}>
                  {t("svnWorkspace.welcome.openCard.browse")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void openTypedPath()}
                  disabled={!pathInput.trim() || openBusy}
                >
                  {openBusy
                    ? t("svnWorkspace.welcome.openCard.opening")
                    : t("svnWorkspace.welcome.openCard.open")}
                </Button>
              </div>
            </div>
          </section>

          <section className="animate-slide-up border-border bg-card shadow-soft rounded-lg border p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="bg-info/15 text-info flex size-9 shrink-0 items-center justify-center rounded-md">
                <FolderSync className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-medium">
                  {t("svnWorkspace.welcome.actions.checkout")}
                </h2>
                <p className="text-muted-foreground text-xs">
                  {t("svnWorkspace.welcome.actions.checkoutHint")}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Input
                value={checkoutUrl}
                onChange={(event) => setCheckoutUrl(event.target.value)}
                placeholder={t("svnWorkspace.welcome.checkoutCard.urlPlaceholder")}
                aria-label={t("svnWorkspace.welcome.checkoutCard.urlLabel")}
                className="h-8 text-sm"
              />
              <div className="flex gap-2">
                <Input
                  value={checkoutInto}
                  onChange={(event) => setCheckoutInto(event.target.value)}
                  placeholder={t("svnWorkspace.welcome.checkoutCard.intoPlaceholder")}
                  aria-label={t("svnWorkspace.welcome.checkoutCard.intoLabel")}
                  className="h-8 text-sm"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void browseForCheckoutInto()}
                >
                  {t("svnWorkspace.welcome.checkoutCard.browse")}
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  value={checkoutRevision}
                  onChange={(event) => setCheckoutRevision(event.target.value)}
                  placeholder={t("svnWorkspace.welcome.checkoutCard.revisionPlaceholder")}
                  aria-label={t("svnWorkspace.welcome.checkoutCard.revisionLabel")}
                  className="h-8 text-sm"
                  inputMode="numeric"
                />
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => void runCheckout()}
                  disabled={!checkoutUrl.trim() || !checkoutInto.trim() || checkoutBusy}
                >
                  {checkoutBusy
                    ? t("svnWorkspace.welcome.checkoutCard.checkingOut")
                    : t("svnWorkspace.welcome.checkoutCard.checkout")}
                </Button>
              </div>
            </div>
          </section>
        </div>

        <section className="animate-slide-up border-border bg-card shadow-soft mt-3 rounded-lg border">
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Clock className="text-muted-foreground size-4" />
            <h2 className="text-sm font-medium">{t("svnWorkspace.welcome.recent.title")}</h2>
            <span className="text-faint text-xs">{visible.length}</span>
            <div className="relative ml-auto w-52">
              <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("svnWorkspace.welcome.recent.searchPlaceholder")}
                aria-label={t("svnWorkspace.welcome.recent.searchLabel")}
                className="h-7 pl-8 text-xs"
              />
            </div>
          </div>

          {recents.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                <FolderSync className="size-6" />
              </span>
              <div>
                <p className="text-sm font-medium">{t("svnWorkspace.welcome.recent.emptyTitle")}</p>
                <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
                  {t("svnWorkspace.welcome.recent.emptyDescription")}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void browseForOpen()}>
                  {t("svnWorkspace.welcome.recent.emptyOpen")}
                </Button>
              </div>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">
              {t("svnWorkspace.welcome.recent.noMatch", { query })}
            </p>
          ) : (
            <ul className="p-1">
              {visible.map((workspace) => (
                <RecentRow
                  key={workspace.path}
                  workspace={workspace}
                  openedAt={relativeTime(workspace.openedAt, language)}
                  isOpen={openLabels.has(svnWorkspaceWindowLabel(workspace.path))}
                  isMissing={missing.has(workspace.path)}
                  labels={{
                    alreadyOpen: t("svnWorkspace.welcome.recent.alreadyOpen"),
                    missing: t("svnWorkspace.welcome.recent.missing"),
                    menuAria: t("svnWorkspace.welcome.recent.menuAria", {
                      name: baseName(workspace.path),
                    }),
                    open: t("svnWorkspace.welcome.recent.open"),
                    focus: t("svnWorkspace.welcome.recent.focus"),
                    reveal: t("svnWorkspace.welcome.recent.reveal"),
                    remove: t("svnWorkspace.welcome.recent.remove"),
                  }}
                  onOpen={() => void openWorkingCopy(workspace.path)}
                  onReveal={() => void revealPath(workspace.path)}
                  onRemove={() => void removeRecent(workspace.path)}
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
  workspace,
  openedAt,
  isOpen,
  isMissing,
  labels,
  onOpen,
  onReveal,
  onRemove,
}: {
  workspace: RecentWorkspace;
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
          <FolderSync className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{baseName(workspace.path)}</span>
            {isOpen ? (
              <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
                {labels.alreadyOpen}
              </Badge>
            ) : null}
          </span>
          <span className="text-faint block truncate font-mono text-[11px]" title={workspace.path}>
            {workspace.path}
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
            <FolderSync className="size-3.5" />
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
