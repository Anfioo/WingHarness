import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ChartPie,
  FolderOpen,
  RotateCw,
  ScanSearch,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { openPath } from "@/commands";
import { systoolsRevealInFileManager, systoolsSystemDisk } from "@/commands/services/systools";
import {
  ANALYSIS_DEFAULT_SUNBURST_DEPTH,
  ANALYSIS_DEFAULT_TREEMAP_DEPTH,
  ANALYSIS_PROGRESS_EVENT,
  analysisBreadcrumbs,
  analysisErrorDetail,
  analysisErrorKey,
  buildHierarchyIndex,
  cancelAnalysis,
  deleteAnalysisEntries,
  directoryListing,
  exportAnalysis,
  isAnalysisCancellation,
  isPathInside,
  isProtectedEntry,
  parentPath,
  pathName,
  pruneAnalysisResult,
  reconciledAnalysisResult,
  samePath,
  scanAnalysis,
  sortAnalysisEntries,
  summarizeAnalysisSelection,
  type AnalysisDeleteBatchResult,
  type AnalysisDirectoryNode,
  type AnalysisProgress,
  type AnalysisRemainderSelection,
  type AnalysisResult,
  type AnalysisScanMode,
  type AnalysisSortDirection,
  type AnalysisSortKey,
  type AnalysisViewId,
  type DirectoryEntryInfo,
} from "@/lib/systools/storage";
import { formatBytes, formatCount } from "@/lib/systools/format";
import { BrowserToolbar } from "../analysis/browser-toolbar";
import { CoverageStrip } from "../analysis/coverage-strip";
import { PermanentDeleteDialog } from "../components/common/permanent-delete-dialog";
import { DeleteResultDialog } from "../analysis/delete-result-dialog";
import { DetailsTable } from "../analysis/details-table";
import { ExportDialog, type AnalysisExportOptions } from "../analysis/export-dialog";
import { FolderPane } from "../analysis/folder-pane";
import { RemainderDialog } from "../analysis/remainder-dialog";
import { ScanProgress } from "../analysis/scan-progress";
import { AnalysisToolbar } from "../analysis/toolbar";
import { VisualPane } from "../analysis/visual-pane";

function sanitizeFileName(value: string): string {
  const sanitized = value
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "analysis";
}

/** Disk usage of a directory tree with treemap and sunburst drill-down. */
export function AnalysisTab() {
  const { t, language } = useAppTranslation();

  const [path, setPath] = useState("");
  const [scanMode, setScanMode] = useState<AnalysisScanMode>("standard");
  const [refresh, setRefresh] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const [drillPath, setDrillPath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<AnalysisSortKey>("bytes");
  const [sortDirection, setSortDirection] = useState<AnalysisSortDirection>("desc");

  const [viewMode, setViewMode] = useState<AnalysisViewId>("treemap");
  const [treemapDepth, setTreemapDepth] = useState(ANALYSIS_DEFAULT_TREEMAP_DEPTH);
  const [sunburstDepth, setSunburstDepth] = useState(ANALYSIS_DEFAULT_SUNBURST_DEPTH);
  const [detailsOpen, setDetailsOpen] = useState(true);

  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [remainder, setRemainder] = useState<AnalysisRemainderSelection | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<DirectoryEntryInfo[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<AnalysisDeleteBatchResult | null>(null);

  const scanTokenRef = useRef(0);

  // -------------------------------------------------------------------------
  // Scan lifecycle
  // -------------------------------------------------------------------------

  const runScan = useCallback(
    async (targetPath: string, options: { refresh?: boolean } = {}) => {
      const token = scanTokenRef.current + 1;
      scanTokenRef.current = token;
      setScanning(true);
      setCancelling(false);
      setProgress(null);
      setErrorKey(null);
      setErrorDetail(null);

      try {
        const next = await scanAnalysis(targetPath, options.refresh ?? refresh, scanMode);
        if (token !== scanTokenRef.current) return;
        setResult(next);
        setPath(next.root);
        setDrillPath(next.root);
        setSelectedPath(null);
        setSelectedPaths(new Set());
      } catch (error) {
        if (token !== scanTokenRef.current) return;
        if (isAnalysisCancellation(error)) {
          toast.info(t("systools.analysis.cancelled"));
        } else {
          const key = analysisErrorKey(error);
          setErrorKey(key);
          setErrorDetail(analysisErrorDetail(error));
          toast.error(t(key));
        }
      } finally {
        if (token === scanTokenRef.current) {
          setScanning(false);
          setCancelling(false);
          setProgress(null);
        }
      }
    },
    [refresh, scanMode, t]
  );

  const cancelScan = useCallback(async () => {
    setCancelling(true);
    try {
      await cancelAnalysis();
    } catch (error) {
      if (!isAnalysisCancellation(error)) {
        toast.error(t(analysisErrorKey(error)));
      }
      setCancelling(false);
    }
  }, [t]);

  // Progress is a view-only signal; the scan promise carries the final result.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<AnalysisProgress>(ANALYSIS_PROGRESS_EVENT, (event) => {
      if (!disposed) setProgress(event.payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Start at the system volume when no path was chosen yet.
  useEffect(() => {
    let active = true;
    systoolsSystemDisk()
      .then((volume) => {
        const mountPoint = typeof volume.mountPoint === "string" ? volume.mountPoint : "";
        if (active && mountPoint) setPath((current) => current || mountPoint);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Derived view data
  // -------------------------------------------------------------------------

  const listing = useMemo(() => {
    if (!result) return null;
    return (
      directoryListing(result, drillPath || result.root) ?? directoryListing(result, result.root)
    );
  }, [result, drillPath]);

  const hierarchy = useMemo<ReadonlyMap<string, AnalysisDirectoryNode>>(
    () => (result ? buildHierarchyIndex(result) : new Map()),
    [result]
  );

  const breadcrumbs = useMemo(
    () => (result ? analysisBreadcrumbs(result.root, listing?.path ?? result.root) : []),
    [result, listing?.path]
  );

  const sortedEntries = useMemo(
    () => (listing ? sortAnalysisEntries(listing.entries, sortKey, sortDirection) : []),
    [listing, sortKey, sortDirection]
  );

  const allSelected =
    sortedEntries.length > 0 && sortedEntries.every((entry) => selectedPaths.has(entry.path));
  const partiallySelected =
    !allSelected && sortedEntries.some((entry) => selectedPaths.has(entry.path));
  const selection = useMemo(
    () => summarizeAnalysisSelection(sortedEntries, selectedPaths),
    [sortedEntries, selectedPaths]
  );

  const canGoUp = Boolean(result && listing && !samePath(listing.path, result.root));

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const navigateTo = useCallback(
    (nextPath: string) => {
      if (!result) return;
      if (!isPathInside(result.root, nextPath)) return;
      const target = directoryListing(result, nextPath);
      if (target) {
        setDrillPath(target.path);
        setSelectedPath(target.path);
        setSelectedPaths(new Set());
        return;
      }
      // Directories outside the bounded projection need a fresh scan.
      void runScan(nextPath);
    },
    [result, runScan]
  );

  const goUp = useCallback(() => {
    if (!result || !listing) return;
    if (samePath(listing.path, result.root)) return;
    const parent = parentPath(listing.path);
    navigateTo(parent && isPathInside(result.root, parent) ? parent : result.root);
  }, [result, listing, navigateTo]);

  const goHome = useCallback(() => {
    if (result) navigateTo(result.root);
  }, [result, navigateTo]);

  const activateEntry = useCallback(
    (entry: DirectoryEntryInfo) => {
      setSelectedPath(entry.path);
      if (entry.isDirectory) navigateTo(entry.path);
    },
    [navigateTo]
  );

  const selectEntry = useCallback((entry: DirectoryEntryInfo) => {
    setSelectedPath(entry.path);
  }, []);

  // -------------------------------------------------------------------------
  // Reveal, selection, sorting
  // -------------------------------------------------------------------------

  const revealPath = useCallback(
    async (target: string) => {
      try {
        await systoolsRevealInFileManager(target);
      } catch {
        toast.error(t("systools.analysis.errors.openFailed"));
      }
    },
    [t]
  );

  const openEntry = useCallback(
    (entry: DirectoryEntryInfo) => {
      void openPath(entry.path).catch(() => {
        toast.error(t("systools.analysis.errors.openFailed"));
      });
    },
    [t]
  );

  const revealEntry = useCallback(
    (entry: DirectoryEntryInfo) => {
      void revealPath(entry.path);
    },
    [revealPath]
  );

  const toggleRow = useCallback((entryPath: string, selected: boolean) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (selected) next.add(entryPath);
      else next.delete(entryPath);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (selected: boolean) => {
      setSelectedPaths(selected ? new Set(sortedEntries.map((entry) => entry.path)) : new Set());
    },
    [sortedEntries]
  );

  const clearSelection = useCallback(() => setSelectedPaths(new Set()), []);

  const handleSort = useCallback(
    (key: AnalysisSortKey) => {
      if (key === sortKey) {
        setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
      } else {
        setSortKey(key);
        setSortDirection(key === "name" ? "asc" : "desc");
      }
    },
    [sortKey]
  );

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  const requestDelete = useCallback((entries: DirectoryEntryInfo[]) => {
    if (entries.length > 0) setDeleteTargets(entries);
  }, []);

  const requestDeleteSelected = useCallback(() => {
    const targets = sortedEntries.filter((entry) => selectedPaths.has(entry.path));
    requestDelete(targets);
  }, [sortedEntries, selectedPaths, requestDelete]);

  const confirmDelete = useCallback(async () => {
    if (!result || deleteTargets.length === 0) return;
    const paths = deleteTargets.map((entry) => entry.path);
    const rescanPath = listing?.path ?? result.root;
    // Destructive authority only covers direct children of a published scan
    // root. A drilled listing is projected from the bounded hierarchy, so
    // publish a scan rooted at the browsed folder before deleting from it.
    const drilled = Boolean(listing?.fromHierarchy);
    setDeleting(true);

    try {
      const authority = drilled ? await scanAnalysis(rescanPath, false, scanMode) : result;
      const batch = await deleteAnalysisEntries(authority.scanId, paths);
      setDeleteTargets([]);
      setDeleteResult(batch);
      setSelectedPaths(new Set());
      setSelectedPath(null);

      const reconciled = reconciledAnalysisResult(result, batch.updatedResults);
      const next = reconciled ?? pruneAnalysisResult(result, batch.removedPaths);
      setResult(next);
      setDrillPath(directoryListing(next, drillPath) ? drillPath : next.root);

      // A drilled delete runs through a temporary scan rooted at the browsed
      // folder. The backend then expires every ancestor session, including the
      // one the view still holds, so re-analyze the original root to restore a
      // usable snapshot instead of leaving a dead scan id behind.
      if (drilled || batch.requiresRescan) {
        void runScan(result.root, { refresh: true });
      }
    } catch (error) {
      if (isAnalysisCancellation(error)) {
        toast.info(t("systools.analysis.errors.cancelled"));
      } else {
        toast.error(t(analysisErrorKey(error)));
      }
    } finally {
      setDeleting(false);
    }
  }, [
    result,
    deleteTargets,
    listing?.path,
    listing?.fromHierarchy,
    drillPath,
    runScan,
    scanMode,
    t,
  ]);

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  const handleExport = useCallback(
    async (options: AnalysisExportOptions) => {
      if (!result) return;
      const extension = options.format === "json" ? "json" : "md";
      const defaultPath = `${sanitizeFileName(pathName(result.root))}-analysis-${new Date()
        .toISOString()
        .slice(0, 10)}.${extension}`;

      let destination: string | null = null;
      try {
        destination = await save({
          title: t("systools.analysis.export.saveTitle"),
          defaultPath,
          filters: [
            {
              name:
                options.format === "json"
                  ? t("systools.analysis.export.formatJson")
                  : t("systools.analysis.export.formatMarkdown"),
              extensions: [extension],
            },
          ],
        });
      } catch {
        toast.error(t("systools.analysis.errors.dialogFailed"));
        return;
      }
      if (!destination) return;

      setExporting(true);
      try {
        const receipt = await exportAnalysis(
          {
            scanId: result.scanId,
            path: destination,
            maxDepth: options.maxDepth,
            maxEntries: options.maxEntries,
            includeFullPaths: options.includeFullPaths,
            format: options.format,
          },
          t("systools.analysis.export.nativeTitle")
        );
        if (!receipt) {
          toast.info(t("systools.analysis.export.cancelled"));
          return;
        }
        setExportOpen(false);
        toast.success(
          t("systools.analysis.export.success", {
            path: receipt.path,
            count: receipt.entryCount,
          })
        );
      } catch (error) {
        toast.error(t(analysisErrorKey(error)));
      } finally {
        setExporting(false);
      }
    },
    [result, t]
  );

  // -------------------------------------------------------------------------
  // Dialogs and toolbar actions
  // -------------------------------------------------------------------------

  const browse = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("systools.analysis.toolbar.browseTitle"),
        defaultPath: path.trim() || undefined,
      });
      if (typeof selected === "string" && selected.trim()) setPath(selected);
    } catch {
      toast.error(t("systools.analysis.errors.dialogFailed"));
    }
  }, [path, t]);

  const startScan = useCallback(() => {
    const target = path.trim();
    if (target) void runScan(target);
  }, [path, runScan]);

  const showRemainder = useCallback(
    (selectionValue: AnalysisRemainderSelection) => setRemainder(selectionValue),
    []
  );

  const busy = deleting || exporting;
  const showEmptyState = !result && !scanning;

  const deletePreviewEntries = deleteTargets.slice(0, 4);
  const deleteBytes = deleteTargets.reduce((total, entry) => total + entry.bytes, 0);
  const protectedDeleteCount = deleteTargets.filter(isProtectedEntry).length;

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="analysis-tab">
      <AnalysisToolbar
        path={path}
        scanMode={scanMode}
        refresh={refresh}
        scanning={scanning}
        cancelling={cancelling}
        busy={busy}
        hasResult={Boolean(result)}
        onPathChange={setPath}
        onBrowse={() => void browse()}
        onRefreshChange={setRefresh}
        onScanModeChange={setScanMode}
        onScan={startScan}
        onCancel={() => void cancelScan()}
        onExport={() => setExportOpen(true)}
      />

      {result ? (
        <CoverageStrip coverage={result.coverage} skippedCount={result.skippedCount} />
      ) : null}

      {scanning && result ? (
        <ScanProgress
          variant="strip"
          progress={progress}
          cancelling={cancelling}
          onCancel={() => void cancelScan()}
        />
      ) : null}

      {errorKey && result ? (
        <div className="text-destructive flex min-w-0 items-center gap-2 border-b px-3 py-1 text-[11px]">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{t(errorKey)}</span>
          {errorDetail ? (
            <span className="text-muted-foreground min-w-0 truncate" title={errorDetail}>
              {errorDetail}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto shrink-0"
            onClick={startScan}
            disabled={scanning || busy}
          >
            <RotateCw className="size-3" />
            {t("systools.common.retry")}
          </Button>
        </div>
      ) : null}

      {showEmptyState ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
          <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <ChartPie className="size-6" aria-hidden="true" />
          </div>
          <div className="max-w-sm space-y-1">
            <h2 className="text-sm font-medium">{t("systools.analysis.emptyTitle")}</h2>
            <p className="text-muted-foreground text-xs">
              {t("systools.analysis.emptyDescription")}
            </p>
          </div>
          {errorKey ? (
            <p className="text-destructive flex items-center gap-1.5 text-xs">
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              {t(errorKey)}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void browse()} disabled={busy}>
              <FolderOpen className="size-4" />
              {t("systools.analysis.toolbar.browse")}
            </Button>
            <Button size="sm" onClick={startScan} disabled={busy || !path.trim()}>
              <ScanSearch className="size-4" />
              {t("systools.analysis.toolbar.scan")}
            </Button>
          </div>
        </div>
      ) : scanning && !result ? (
        <div className="min-h-0 flex-1">
          <ScanProgress
            progress={progress}
            cancelling={cancelling}
            onCancel={() => void cancelScan()}
          />
        </div>
      ) : result && listing ? (
        <>
          <BrowserToolbar
            breadcrumbs={breadcrumbs}
            canGoUp={canGoUp}
            detailsOpen={detailsOpen}
            disabled={scanning || busy}
            onNavigate={navigateTo}
            onUp={goUp}
            onHome={goHome}
            onToggleDetails={() => setDetailsOpen((current) => !current)}
          />

          <div className="flex min-h-0 flex-1">
            <div className="flex w-2/5 max-w-[46%] min-w-[190px] shrink-0 flex-col border-r">
              <FolderPane
                listing={listing}
                selectedPath={selectedPath}
                disabled={scanning || busy}
                onActivate={activateEntry}
                onShowRemainder={showRemainder}
                onOpen={openEntry}
                onReveal={revealEntry}
                onDelete={(entry) => requestDelete([entry])}
              />
            </div>
            <div className="min-w-0 flex-1">
              <VisualPane
                listing={listing}
                hierarchy={hierarchy}
                viewMode={viewMode}
                treemapDepth={treemapDepth}
                sunburstDepth={sunburstDepth}
                canGoUp={canGoUp}
                selectedPath={selectedPath}
                disabled={scanning || busy}
                onViewModeChange={setViewMode}
                onTreemapDepthChange={setTreemapDepth}
                onSunburstDepthChange={setSunburstDepth}
                onSelect={selectEntry}
                onNavigate={navigateTo}
                onGoUp={goUp}
                onShowRemainder={showRemainder}
                onOpen={openEntry}
                onReveal={revealEntry}
                onDelete={(entry) => requestDelete([entry])}
              />
            </div>
          </div>

          {detailsOpen ? (
            <div className="h-[38%] min-h-[118px] shrink-0 border-t">
              <DetailsTable
                listing={listing}
                entries={sortedEntries}
                sortKey={sortKey}
                sortDirection={sortDirection}
                selectedPaths={selectedPaths}
                selection={selection}
                allSelected={allSelected}
                partiallySelected={partiallySelected}
                disabled={scanning || busy}
                onSort={handleSort}
                onToggle={toggleRow}
                onToggleAll={toggleAll}
                onClearSelection={clearSelection}
                onActivate={activateEntry}
                onOpen={openEntry}
                onReveal={revealEntry}
                onDelete={(entry) => requestDelete([entry])}
                onDeleteSelected={requestDeleteSelected}
              />
            </div>
          ) : null}
        </>
      ) : null}

      <ExportDialog
        open={exportOpen}
        exporting={exporting}
        onOpenChange={setExportOpen}
        onExport={(options) => void handleExport(options)}
      />

      <RemainderDialog
        open={remainder !== null}
        scanId={result?.scanId ?? null}
        selection={remainder}
        onOpenChange={(next) => {
          if (!next) setRemainder(null);
        }}
        onNavigate={navigateTo}
        onReveal={(target) => void revealPath(target)}
      />

      <PermanentDeleteDialog
        open={deleteTargets.length > 0}
        busy={deleting}
        title={t("systools.analysis.delete.title")}
        description={t("systools.analysis.delete.description")}
        stats={[
          {
            label: t("systools.analysis.delete.items"),
            value: formatCount(deleteTargets.length, language),
          },
          {
            label: t("systools.analysis.delete.size"),
            value: formatBytes(deleteBytes, language),
          },
        ]}
        preview={
          <div className="max-h-28 overflow-y-auto rounded-md border px-3 py-1.5 text-[11px]">
            {deletePreviewEntries.map((entry) => (
              <p key={entry.path} className="flex items-baseline gap-2 py-0.5">
                <span className="min-w-0 flex-1 truncate" title={entry.path}>
                  {entry.name}
                </span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {formatBytes(entry.bytes, language)}
                </span>
              </p>
            ))}
            {deleteTargets.length > deletePreviewEntries.length ? (
              <p className="text-muted-foreground py-0.5">
                {t("systools.analysis.delete.more", {
                  count: deleteTargets.length - deletePreviewEntries.length,
                })}
              </p>
            ) : null}
          </div>
        }
        extraNotice={
          protectedDeleteCount > 0 ? (
            <p className="text-muted-foreground flex items-start gap-2 text-xs">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {t("systools.analysis.delete.protectedWarning", {
                  count: protectedDeleteCount,
                })}
              </span>
            </p>
          ) : null
        }
        warning={t("systools.analysis.delete.note")}
        cancelLabel={t("systools.common.cancel")}
        busyLabel={t("systools.analysis.delete.deleting")}
        confirmLabel={t("systools.analysis.delete.confirm")}
        confirmDisabled={deleteTargets.length === 0}
        onOpenChange={(next) => {
          if (!next && !deleting) setDeleteTargets([]);
        }}
        onConfirm={() => void confirmDelete()}
      />

      <DeleteResultDialog
        open={deleteResult !== null}
        result={deleteResult}
        onOpenChange={(next) => {
          if (!next) setDeleteResult(null);
        }}
      />
    </div>
  );
}
