import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Loader2,
  X,
} from "lucide-react";
import type { CommitFileInfo, FileDiff } from "@/lib/git-core";
import { ChangeMark, statusMeta } from "@/components/git/change-mark";
import { DirName } from "@/components/git/dir-name";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { diffCommitFile, diffCommitFiles } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { useUi, type CenterDiffTarget } from "@/features/git/ui-store";
import { basename } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useShortcuts } from "./use-shortcuts";
import { DiffViewer } from "./diff-viewer";
import { DiffLayoutToggle, DiffViewControls, MenuNote } from "./diff-view-controls";
import { Hint, Kbd } from "./diff-ui";

const LARGE_FILE_LINES = 1500;
const LOAD_AHEAD = "1200px 0px";
const MAX_PARALLEL = 4;
const LINE_ESTIMATE = 20;
const SECTION_GAP = 12;

interface Loaded {
  diff: FileDiff | null;
  error: string | null;
}

const changedLines = (file: CommitFileInfo) => file.additions + file.deletions;
const isLarge = (file: CommitFileInfo) => changedLines(file) > LARGE_FILE_LINES;
const estimateHeight = (file: CommitFileInfo) =>
  file.isBinary || file.isImage ? 120 : Math.min(changedLines(file) * LINE_ESTIMATE + 80, 6000);

export function AllChangesView({ target }: { target?: CenterDiffTarget & { oid: string } } = {}) {
  const storeTarget = useUi((s) => s.centerDiff);
  const resolved = target ?? storeTarget;
  if (!resolved?.oid) return null;
  return <AllChangesBody target={resolved as CenterDiffTarget & { oid: string }} />;
}

function AllChangesBody({ target }: { target: CenterDiffTarget & { oid: string } }) {
  const { t } = useAppTranslation();
  const repoPath = useRepo((s) => s.repo?.path ?? "");
  const closeCenterDiff = useUi((s) => s.closeCenterDiff);
  const openCenterDiff = useUi((s) => s.openCenterDiff);
  const setDiffLayout = useUi((s) => s.setDiffLayout);
  const ignoreWhitespace = useUi((s) => s.ignoreWhitespace);
  const fullFileDiff = useUi((s) => s.fullFileDiff);
  const diffView = useUi((s) => s.diffView);
  const oid = target.oid;
  const [files, setFiles] = useState<CommitFileInfo[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string>(target.path);
  const rootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const heights = useRef(new Map<HTMLElement, number>());
  const visible = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const inflight = useRef(new Set<string>());
  const generation = useRef(0);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const syncedFromScroll = useRef<string | null>(null);
  const userScrolling = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setFilesError(null);
    setLoaded({});
    setCollapsed(new Set());
    diffCommitFiles(repoPath, oid)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setCollapsed(new Set(list.filter(isLarge).map((file) => file.path)));
      })
      .catch((error) => {
        if (cancelled) return;
        setFilesError(String((error as { message?: string }).message ?? error));
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, oid]);

  const fileByPath = useMemo(
    () => new Map((files ?? []).map((file) => [file.path, file])),
    [files]
  );

  const pump = useCallback(() => {
    while (inflight.current.size < MAX_PARALLEL && queue.current.length > 0) {
      const path = queue.current.shift()!;
      const file = fileByPath.get(path);
      if (!file || loadedRef.current[path] || inflight.current.has(path)) continue;
      const gen = generation.current;
      inflight.current.add(path);
      void diffCommitFile(
        repoPath,
        file.sourceOid ?? oid,
        path,
        file.oldPath ?? undefined,
        fullFileDiff ? 10_000_000 : undefined,
        ignoreWhitespace
      )
        .then((diff) => {
          if (gen !== generation.current) return;
          const untouched =
            diff.hunks.length === 0 &&
            diff.additions === 0 &&
            diff.deletions === 0 &&
            !diff.isBinary &&
            !diff.isImage;
          setLoaded((prev) => ({
            ...prev,
            [path]: { diff: untouched ? null : diff, error: null },
          }));
        })
        .catch((error) => {
          if (gen !== generation.current) return;
          setLoaded((prev) => ({
            ...prev,
            [path]: { diff: null, error: String((error as { message?: string }).message ?? error) },
          }));
        })
        .finally(() => {
          if (gen !== generation.current) return;
          inflight.current.delete(path);
          pump();
        });
    }
  }, [fileByPath, repoPath, oid, fullFileDiff, ignoreWhitespace]);

  const request = useCallback(
    (path: string) => {
      if (collapsedRef.current.has(path) || loadedRef.current[path] || inflight.current.has(path))
        return;
      if (!queue.current.includes(path)) queue.current.push(path);
      pump();
    },
    [pump]
  );

  useEffect(() => {
    generation.current++;
    queue.current = [];
    inflight.current.clear();
    setLoaded({});
    loadedRef.current = {};
    for (const path of visible.current) request(path);
  }, [repoPath, oid, fullFileDiff, ignoreWhitespace, request]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.filePath;
          if (!path) continue;
          if (entry.isIntersecting) {
            visible.current.add(path);
            request(path);
          } else {
            visible.current.delete(path);
          }
        }
      },
      { root, rootMargin: LOAD_AHEAD }
    );
    for (const el of sections.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [files, request]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const next = el.offsetHeight;
        const prev = heights.current.get(el) ?? next;
        heights.current.set(el, next);
        if (next !== prev && el.offsetTop + el.offsetHeight < root.scrollTop) {
          root.scrollTop += next - prev;
        }
      }
    });
    for (const el of sections.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [files]);

  useLayoutEffect(() => {
    if (!files) return;
    const synced = syncedFromScroll.current;
    syncedFromScroll.current = null;
    if (synced === target.path) return;
    const root = scrollRef.current;
    const el = sections.current.get(target.path);
    if (!root || !el) return;
    userScrolling.current = false;
    root.scrollTop = el.offsetTop;
    setActive(target.path);
  }, [files, target.path]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const markUser = () => {
      userScrolling.current = true;
    };
    root.addEventListener("wheel", markUser, { passive: true });
    root.addEventListener("touchmove", markUser, { passive: true });
    root.addEventListener("pointerdown", markUser);
    root.addEventListener("keydown", markUser);
    return () => {
      root.removeEventListener("wheel", markUser);
      root.removeEventListener("touchmove", markUser);
      root.removeEventListener("pointerdown", markUser);
      root.removeEventListener("keydown", markUser);
    };
  }, []);

  const frame = useRef<number | null>(null);
  const onScroll = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const root = scrollRef.current;
      if (!root || !files || !userScrolling.current) return;
      let current = files[0]?.path ?? null;
      for (const file of files) {
        const el = sections.current.get(file.path);
        if (!el) continue;
        if (el.offsetTop <= root.scrollTop + SECTION_GAP) current = file.path;
        else break;
      }
      if (!current || current === active) return;
      setActive(current);
      syncedFromScroll.current = current;
      const file = fileByPath.get(current);
      openCenterDiff({ path: current, oid, oldPath: file?.oldPath ?? null });
    });
  };

  const index = files ? files.findIndex((file) => file.path === active) : -1;
  const goFile = (direction: 1 | -1) => {
    if (!files || index < 0) return;
    const next = files[index + direction];
    if (!next) return;
    syncedFromScroll.current = null;
    openCenterDiff({ path: next.path, oid, oldPath: next.oldPath });
  };
  const goFileRef = useRef(goFile);
  goFileRef.current = goFile;
  const arrowKeysBelongHere = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return false;
    const ui = useUi.getState();
    if (ui.paletteOpen || ui.dialog || ui.conflictFile) return false;
    const focused = document.activeElement;
    return !focused || focused === document.body || !!rootRef.current?.contains(focused);
  };
  useShortcuts(
    useMemo(
      () => [
        { combo: "[", handler: () => goFileRef.current(-1), skipInInput: true },
        { combo: "]", handler: () => goFileRef.current(1), skipInInput: true },
        {
          combo: "arrowleft",
          skipInInput: true,
          handler: (event: KeyboardEvent) => {
            if (!arrowKeysBelongHere(event)) return;
            useUi.getState().closeCenterDiff();
            useUi.getState().focusGraph();
          },
        },
      ],

      []
    )
  );

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      collapsedRef.current = next;
      if (!next.has(path)) queueMicrotask(() => request(path));
      return next;
    });
  };

  const allCollapsed =
    !!files && files.length > 0 && files.every((file) => collapsed.has(file.path));
  const toggleAll = () => {
    if (allCollapsed) {
      const next = new Set<string>();
      collapsedRef.current = next;
      setCollapsed(next);
      queueMicrotask(() => {
        for (const path of visible.current) request(path);
      });
    } else {
      const next = new Set(files?.map((file) => file.path) ?? []);
      collapsedRef.current = next;
      setCollapsed(next);
    }
  };

  const openInFileView = (file: CommitFileInfo) => {
    setDiffLayout("file");
    openCenterDiff({ path: file.path, oid: file.sourceOid ?? oid, oldPath: file.oldPath });
  };

  const totals = useMemo(
    () =>
      (files ?? []).reduce(
        (acc, file) => ({
          additions: acc.additions + file.additions,
          deletions: acc.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 }
      ),
    [files]
  );

  return (
    <section
      ref={rootRef}
      className="bg-background flex h-full flex-col"
      aria-label={t("gitRepo.diff.all.ariaLabel", { oid: oid.slice(0, 8) })}
      data-all-changes
    >
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3 whitespace-nowrap">
        <Hint
          label={
            <span className="flex items-center gap-1">
              {t("gitRepo.diff.all.backToGraph")} <Kbd>Esc</Kbd>
            </span>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.diff.all.close")}
            onClick={closeCenterDiff}
          >
            <X className="size-4" />
          </Button>
        </Hint>
        <span className="text-xs font-medium">{t("gitRepo.diff.all.title")}</span>
        <Badge variant="secondary" className="font-mono">
          {oid.slice(0, 8)}
        </Badge>
        {files && (
          <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
            {t("gitRepo.diff.all.fileCount", { count: files.length })}
            <span className="text-success">+{totals.additions}</span>
            <span className="text-destructive">−{totals.deletions}</span>
          </span>
        )}
        <span className="flex-1" />
        <DiffLayoutToggle />
        <DiffViewControls
          notes={
            diffView === "split" ? (
              <MenuNote>{t("gitRepo.diff.all.sideBySideNote")}</MenuNote>
            ) : undefined
          }
        />
        <Hint
          label={allCollapsed ? t("gitRepo.diff.all.expandAll") : t("gitRepo.diff.all.collapseAll")}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              allCollapsed ? t("gitRepo.diff.all.expandAll") : t("gitRepo.diff.all.collapseAll")
            }
            disabled={!files || files.length === 0}
            onClick={toggleAll}
          >
            {allCollapsed ? (
              <ChevronsUpDown className="size-3.5" />
            ) : (
              <ChevronsDownUp className="size-3.5" />
            )}
          </Button>
        </Hint>
        {files && files.length > 1 && (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Hint
              label={
                <span className="flex items-center gap-1">
                  {t("gitRepo.diff.all.previousFile")} <Kbd>[</Kbd>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.diff.all.previousFile")}
                disabled={index <= 0}
                onClick={() => goFile(-1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
            </Hint>
            <span className="text-faint text-[10px] tabular-nums">
              {t("gitRepo.diff.all.filePosition", { current: index + 1, total: files.length })}
            </span>
            <Hint
              label={
                <span className="flex items-center gap-1">
                  {t("gitRepo.diff.all.nextFile")} <Kbd>]</Kbd>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.diff.all.nextFile")}
                disabled={index < 0 || index >= files.length - 1}
                onClick={() => goFile(1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </Hint>
          </>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-6"
        data-all-changes-scroller
      >
        {filesError ? (
          <p className="text-destructive py-16 text-center text-sm [overflow-wrap:anywhere]">
            {t("gitRepo.diff.all.listError", { message: filesError })}
          </p>
        ) : !files ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : files.length === 0 ? (
          <p className="text-faint py-16 text-center text-sm">{t("gitRepo.diff.all.noFiles")}</p>
        ) : (
          files.map((file) => {
            const meta = statusMeta[file.status];
            const isCollapsed = collapsed.has(file.path);
            const entry = loaded[file.path];
            const isActive = file.path === active;
            return (
              <section
                key={file.path}
                ref={(el) => {
                  if (el) sections.current.set(file.path, el);
                  else sections.current.delete(file.path);
                }}
                data-file-path={file.path}
                data-file-section={isCollapsed ? "collapsed" : "open"}
                className="border-border bg-card mt-3 rounded-lg border"
              >
                <header
                  className={cn(
                    "bg-card sticky top-0 z-10 flex h-9 items-center gap-2 rounded-t-lg border-b px-2",
                    isCollapsed ? "rounded-b-lg border-transparent" : "border-border",
                    isActive && "shadow-[inset_2px_0_0_var(--primary)]"
                  )}
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      isCollapsed
                        ? t("gitRepo.diff.all.expandFile", { path: file.path })
                        : t("gitRepo.diff.all.collapseFile", { path: file.path })
                    }
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(file.path)}
                  >
                    <ChevronDown
                      className={cn("size-3.5 transition-transform", isCollapsed && "-rotate-90")}
                    />
                  </Button>
                  <ChangeMark tone={meta.tone} title={meta.label}>
                    {meta.mark}
                  </ChangeMark>
                  <span
                    className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs"
                    title={file.path}
                  >
                    <span className="max-w-full shrink-0 truncate font-medium">
                      {basename(file.path)}
                    </span>
                    <DirName path={file.path} className="text-[11px]" />
                    {file.oldPath && file.oldPath !== file.path && (
                      <span className="text-faint shrink-0 truncate text-[11px]">
                        {t("gitRepo.diff.all.from", { path: file.oldPath })}
                      </span>
                    )}
                  </span>
                  {file.additions > 0 && (
                    <span className="text-success shrink-0 font-mono text-[11px]">
                      +{file.additions}
                    </span>
                  )}
                  {file.deletions > 0 && (
                    <span className="text-destructive shrink-0 font-mono text-[11px]">
                      −{file.deletions}
                    </span>
                  )}
                  <Hint label={t("gitRepo.diff.all.openInFileView")}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("gitRepo.diff.all.openFileInView", { path: file.path })}
                      onClick={() => openInFileView(file)}
                    >
                      <FileText className="size-3.5" />
                    </Button>
                  </Hint>
                </header>
                {isCollapsed ? (
                  isLarge(file) && (
                    <div className="border-border text-muted-foreground flex items-center gap-3 rounded-b-lg border-t px-4 py-3 text-xs">
                      <span className="flex-1">
                        {t("gitRepo.diff.all.largeHint", { count: changedLines(file) })}
                      </span>
                      <Button variant="secondary" size="sm" onClick={() => toggle(file.path)}>
                        {t("gitRepo.diff.all.showDiff")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openInFileView(file)}>
                        {t("gitRepo.diff.all.openInFileView")}
                      </Button>
                    </div>
                  )
                ) : !entry ? (
                  <div
                    className="flex items-center justify-center"
                    style={{ height: estimateHeight(file) }}
                  >
                    <Loader2 className="text-faint size-4 animate-spin" />
                  </div>
                ) : entry.error ? (
                  <div className="flex items-center gap-3 px-4 py-4 text-xs">
                    <span className="text-destructive flex-1 [overflow-wrap:anywhere]">
                      {t("gitRepo.diff.all.loadError", { message: entry.error })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLoaded((prev) => {
                          const next = { ...prev };
                          delete next[file.path];
                          loadedRef.current = next;
                          return next;
                        });
                        queueMicrotask(() => request(file.path));
                      }}
                    >
                      {t("gitRepo.diff.all.retry")}
                    </Button>
                  </div>
                ) : !entry.diff ? (
                  <p className="text-faint py-6 text-center text-xs">
                    {ignoreWhitespace
                      ? t("gitRepo.diff.all.whitespaceOnly")
                      : t("gitRepo.diff.all.noTextChanges")}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-b-lg" data-file-diff>
                    <DiffViewer diff={entry.diff} stacked />
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
