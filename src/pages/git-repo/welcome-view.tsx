import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Clock,
  Copy,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  FolderTree,
  GitBranchPlus,
  MoreHorizontal,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useRepo } from "@/features/git/repository-store";
import { activateTab } from "@/features/git/repository/tabs";
import { basename, shortenHome, timeAgo } from "@/features/git/utils";
import {
  openPath,
  pathsExist,
  recentAddMany,
  recentRemove,
  repoClone,
  repoInit,
  repositoriesScan,
} from "@/commands";
import type { RecentRepository, RepositoryScan } from "@/lib/git-core";
import { gitRepoWindowLabel, openGitRepoWindowLabels } from "@/lib/git-windows";
import { cn } from "@/lib/utils";

/**
 * The Git feature's own page: pick a repository. It is a page of the main
 * window, and every repository it opens gets a window of its own, so with the
 * window on screen already there is nothing left for this page to show.
 *
 * The strings live under `gitRepo.welcome.*` while the JSX reads `header.brand`
 * and the like, so the namespace is fixed once here via `keyPrefix`.
 */
export function WelcomeView() {
  const { t } = useTranslation("translation", { keyPrefix: "gitRepo.welcome" });
  const recents = useRepo((state) => state.recents);

  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [openLabels, setOpenLabels] = useState<Set<string>>(new Set());

  const [pathInput, setPathInput] = useState("");
  const [initing, setIniting] = useState(false);

  const cloneUrlRef = useRef<HTMLInputElement>(null);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneInto, setCloneInto] = useState("");
  const [cloneBranch, setCloneBranch] = useState("");
  const [cloning, setCloning] = useState(false);

  const [scanOpen, setScanOpen] = useState(false);
  const [scanRoot, setScanRoot] = useState("");
  const [scanResult, setScanResult] = useState<RepositoryScan | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    void useRepo.getState().loadRecents();
  }, []);

  // Which repositories already have a window open, in the same identity the
  // window labels use: the same folder written two ways must not read as two
  // repositories. Nothing announces a window closing, so the list is re-scanned
  // whenever this window comes back to the front, which is the only moment it
  // can have changed without this page doing it.
  const refreshOpenLabels = useCallback(() => {
    void openGitRepoWindowLabels().then((labels) => setOpenLabels(new Set(labels)));
  }, []);

  useEffect(() => {
    refreshOpenLabels();
    window.addEventListener("focus", refreshOpenLabels);
    document.addEventListener("visibilitychange", refreshOpenLabels);
    return () => {
      window.removeEventListener("focus", refreshOpenLabels);
      document.removeEventListener("visibilitychange", refreshOpenLabels);
    };
  }, [refreshOpenLabels]);

  // A recent whose folder has since been deleted cannot be opened.
  useEffect(() => {
    if (recents.length === 0) {
      setMissing(new Set());
      return;
    }
    let cancelled = false;
    void pathsExist(recents.map((repo) => repo.path))
      .then((flags) => {
        if (cancelled) return;
        const next = new Set<string>();
        recents.forEach((repo, index) => {
          if (!flags[index]) next.add(repo.path);
        });
        setMissing(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recents]);

  const openRepository = useCallback(
    (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return;
      if (missing.has(trimmed)) {
        toast.error(t("toast.missingFolder"));
        return;
      }
      activateTab(trimmed);
    },
    [missing, t]
  );

  const revealPath = useCallback(
    async (path: string) => {
      try {
        await openPath(path);
      } catch (error) {
        toast.error(t("toast.revealFailed"));
        console.error("Failed to reveal path:", error);
      }
    },
    [t]
  );

  const copyPath = useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(path);
        toast.success(t("toast.copied"));
      } catch (error) {
        toast.error(t("toast.copyFailed"));
        console.error("Failed to copy path:", error);
      }
    },
    [t]
  );

  const removeRecent = useCallback(async (path: string) => {
    await recentRemove(path);
    await useRepo.getState().loadRecents();
  }, []);

  const browseForRepository = useCallback(async () => {
    const dir = await pickDirectory({ directory: true });
    if (typeof dir === "string") setPathInput(dir);
  }, []);

  const openTypedPath = useCallback(async () => {
    const path = pathInput.trim();
    if (!path) return;
    const [exists] = await pathsExist([path]);
    if (!exists) {
      toast.error(t("toast.missingFolder"));
      return;
    }
    openRepository(path);
  }, [openRepository, pathInput, t]);

  const initializeRepository = useCallback(async () => {
    const path = pathInput.trim();
    if (!path || initing) return;
    setIniting(true);
    try {
      await repoInit(path);
      toast.success(t("toast.initDone"));
      openRepository(path);
    } catch (error) {
      toast.error(t("toast.initFailed"));
      console.error("Failed to initialize repository:", error);
    } finally {
      setIniting(false);
    }
  }, [initing, openRepository, pathInput, t]);

  const browseForCloneInto = useCallback(async () => {
    const dir = await pickDirectory({ directory: true });
    if (typeof dir === "string") setCloneInto(dir);
  }, []);

  const cloneRepository = useCallback(async () => {
    const url = cloneUrl.trim();
    const into = cloneInto.trim();
    if (!url || !into || cloning) return;
    setCloning(true);
    try {
      const path = await repoClone(url, into, cloneBranch.trim() || undefined);
      await recentAddMany([path]);
      await useRepo.getState().loadRecents();
      toast.success(t("toast.cloneDone", { name: basename(path) }));
      openRepository(path);
    } catch (error) {
      toast.error(t("toast.cloneFailed"));
      console.error("Failed to clone repository:", error);
    } finally {
      setCloning(false);
    }
  }, [cloneBranch, cloneInto, cloneUrl, cloning, openRepository, t]);

  const browseForScanRoot = useCallback(async () => {
    const dir = await pickDirectory({ directory: true });
    if (typeof dir === "string") setScanRoot(dir);
  }, []);

  const scanFolder = useCallback(async () => {
    const root = scanRoot.trim();
    if (!root || scanning) return;
    setScanning(true);
    try {
      setScanResult(await repositoriesScan(root));
    } catch (error) {
      toast.error(t("toast.scanFailed"));
      console.error("Failed to scan folder:", error);
    } finally {
      setScanning(false);
    }
  }, [scanRoot, scanning, t]);

  const addScannedToRecents = useCallback(async () => {
    if (!scanResult || scanResult.repositories.length === 0) return;
    await recentAddMany(scanResult.repositories.map((repo) => repo.path));
    await useRepo.getState().loadRecents();
    setScanResult(null);
    setScanRoot("");
    setScanOpen(false);
  }, [scanResult]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recents;
    return recents.filter(
      (repo) => repo.name.toLowerCase().includes(needle) || repo.path.toLowerCase().includes(needle)
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
              {t("header.brand")}
            </h1>
            <p className="text-muted-foreground text-sm">{t("header.tagline")}</p>
          </div>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          <section className="animate-slide-up border-border bg-card shadow-soft rounded-lg border p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="bg-primary/15 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
                <FolderOpen className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-medium">{t("actions.open")}</h2>
                <p className="text-muted-foreground text-xs">{t("actions.openHint")}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Input
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void openTypedPath();
                }}
                placeholder={t("openCard.pathPlaceholder")}
                aria-label={t("openCard.pathLabel")}
                className="h-8 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => void browseForRepository()}>
                  {t("openCard.browse")}
                </Button>
                <Button size="sm" onClick={() => void openTypedPath()} disabled={!pathInput.trim()}>
                  {t("openCard.open")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void initializeRepository()}
                  disabled={!pathInput.trim() || initing}
                >
                  {initing ? t("openCard.initializing") : t("openCard.initialize")}
                </Button>
              </div>
            </div>
          </section>

          <section className="animate-slide-up border-border bg-card shadow-soft rounded-lg border p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="bg-info/15 text-info flex size-9 shrink-0 items-center justify-center rounded-md">
                <GitBranchPlus className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-medium">{t("actions.clone")}</h2>
                <p className="text-muted-foreground text-xs">{t("actions.cloneHint")}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Input
                ref={cloneUrlRef}
                value={cloneUrl}
                onChange={(event) => setCloneUrl(event.target.value)}
                placeholder={t("cloneCard.urlPlaceholder")}
                aria-label={t("cloneCard.urlLabel")}
                className="h-8 text-sm"
              />
              <div className="flex gap-2">
                <Input
                  value={cloneInto}
                  onChange={(event) => setCloneInto(event.target.value)}
                  placeholder={t("cloneCard.intoPlaceholder")}
                  aria-label={t("cloneCard.intoLabel")}
                  className="h-8 text-sm"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void browseForCloneInto()}
                >
                  {t("cloneCard.browse")}
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  value={cloneBranch}
                  onChange={(event) => setCloneBranch(event.target.value)}
                  placeholder={t("cloneCard.branchPlaceholder")}
                  aria-label={t("cloneCard.branchLabel")}
                  className="h-8 text-sm"
                />
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => void cloneRepository()}
                  disabled={!cloneUrl.trim() || !cloneInto.trim() || cloning}
                >
                  {cloning ? t("cloneCard.cloning") : t("cloneCard.clone")}
                </Button>
              </div>
            </div>
          </section>
        </div>

        <section className="animate-slide-up border-border bg-card shadow-soft mt-3 rounded-lg border">
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Clock className="text-muted-foreground size-4" />
            <h2 className="text-sm font-medium">{t("recent.title")}</h2>
            <span className="text-faint text-xs">{visible.length}</span>
            <div className="relative ml-auto w-52">
              <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("recent.searchPlaceholder")}
                aria-label={t("recent.searchLabel")}
                className="h-7 pl-8 text-xs"
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setScanOpen((open) => !open)}
              aria-label={scanOpen ? t("scan.close") : t("scan.open")}
              title={scanOpen ? t("scan.close") : t("scan.open")}
            >
              <FolderSearch className="size-4" />
            </Button>
          </div>

          {scanOpen ? (
            <div className="border-border border-b px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={scanRoot}
                  onChange={(event) => setScanRoot(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void scanFolder();
                  }}
                  placeholder={t("scan.rootPlaceholder")}
                  aria-label={t("scan.rootLabel")}
                  className="h-8 flex-1 text-sm"
                />
                <Button variant="outline" size="sm" onClick={() => void browseForScanRoot()}>
                  {t("scan.browse")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void scanFolder()}
                  disabled={!scanRoot.trim() || scanning}
                >
                  {scanning ? t("scan.scanning") : t("scan.start")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    setScanOpen(false);
                    setScanResult(null);
                  }}
                  aria-label={t("scan.close")}
                >
                  <X className="size-4" />
                </Button>
              </div>

              {scanResult ? (
                scanResult.repositories.length === 0 ? (
                  <p className="text-muted-foreground mt-3 text-xs">{t("scan.empty")}</p>
                ) : (
                  <div className="mt-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-muted-foreground text-xs">
                        {t("scan.results", { count: scanResult.repositories.length })}
                      </p>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => void addScannedToRecents()}
                      >
                        {t("scan.addAll")}
                      </Button>
                    </div>
                    <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
                      {scanResult.repositories.map((repo) => (
                        <li
                          key={repo.path}
                          className="flex items-center gap-2 rounded-md px-2 py-1"
                        >
                          {repo.isWorktree ? (
                            <FolderTree className="text-faint size-3.5 shrink-0" />
                          ) : (
                            <FolderGit2 className="text-faint size-3.5 shrink-0" />
                          )}
                          <span className="truncate text-sm">{repo.name}</span>
                          <span
                            className="text-faint truncate font-mono text-[11px]"
                            title={repo.path}
                          >
                            {shortenHome(repo.path)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {scanResult.truncated ? (
                      <p className="text-faint mt-2 text-[11px]">{t("scan.truncated")}</p>
                    ) : null}
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          {recents.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                <FolderGit2 className="size-6" />
              </span>
              <div>
                <p className="text-sm font-medium">{t("recent.emptyTitle")}</p>
                <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">
                  {t("recent.emptyDescription")}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void browseForRepository()}>
                  {t("recent.emptyOpen")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setScanOpen(true)}>
                  {t("recent.emptyScan")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => cloneUrlRef.current?.focus()}>
                  {t("recent.emptyClone")}
                </Button>
              </div>
            </div>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">
              {t("recent.noMatch", { query })}
            </p>
          ) : (
            <ul className="p-1">
              {visible.map((repo) => (
                <RecentRow
                  key={repo.path}
                  repo={repo}
                  isOpen={openLabels.has(gitRepoWindowLabel(repo.path))}
                  isMissing={missing.has(repo.path)}
                  labels={{
                    alreadyOpen: t("recent.alreadyOpen"),
                    missing: t("recent.missing"),
                    menuAria: t("recent.menuAria", { name: repo.name }),
                    open: t("recent.open"),
                    focus: t("recent.focus"),
                    reveal: t("recent.reveal"),
                    copyPath: t("recent.copyPath"),
                    remove: t("recent.remove"),
                  }}
                  onOpen={() => openRepository(repo.path)}
                  onReveal={() => void revealPath(repo.path)}
                  onCopyPath={() => void copyPath(repo.path)}
                  onRemove={() => void removeRecent(repo.path)}
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
  copyPath: string;
  remove: string;
}

interface RecentRowProps {
  repo: RecentRepository;
  isOpen: boolean;
  isMissing: boolean;
  labels: RecentRowLabels;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onRemove: () => void;
}

function RecentRow({
  repo,
  isOpen,
  isMissing,
  labels,
  onOpen,
  onReveal,
  onCopyPath,
  onRemove,
}: RecentRowProps) {
  return (
    <li className="group hover:bg-accent flex items-center gap-3 rounded-md px-2 py-1.5">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
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
            <span className="truncate text-sm font-medium">{repo.name}</span>
            {isOpen ? (
              <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
                {labels.alreadyOpen}
              </Badge>
            ) : null}
          </span>
          <span className="text-faint block truncate font-mono text-[11px]" title={repo.path}>
            {shortenHome(repo.path)}
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
          timeAgo(repo.lastOpenedAt)
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
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-faint truncate font-mono text-[11px] font-normal">
            {shortenHome(repo.path)}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpen} disabled={isMissing}>
            <FolderGit2 className="size-3.5" />
            {isOpen ? labels.focus : labels.open}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onReveal} disabled={isMissing}>
            <FolderOpen className="size-3.5" />
            {labels.reveal}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCopyPath}>
            <Copy className="size-3.5" />
            {labels.copyPath}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="size-3.5" />
            {labels.remove}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
