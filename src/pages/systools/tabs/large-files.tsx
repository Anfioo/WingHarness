import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, HardDrive, RefreshCw, ScanSearch, SearchX, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SystoolsPrefs } from "@/commands/services/systools/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  LARGE_FILE_DEFAULT_MINIMUM_BYTES,
  LARGE_FILE_DEFAULT_SCAN_MODE,
  LARGE_FILE_MINIMUM_FLOOR_BYTES,
  LARGE_FILES_PROGRESS_EVENT,
  cancelLargeFilesScan,
  deleteLargeFiles,
  filterLargeFiles,
  isLargeFilesCancellation,
  largeFilesErrorKey,
  listVolumes,
  loadLargeFilePrefs,
  minimumSizeBytes,
  openLargeFile,
  pruneLargeFileSelection,
  removeLargeFilePaths,
  resolveExistingDirectories,
  revealLargeFile,
  scanLargeFiles,
  selectedLargeFiles,
  selectionSummary,
  setLargeFilesSelected,
  sortLargeFiles,
  systemDisk,
  uniqueRoots,
  type LargeFileEntry,
  type LargeFileScanMode,
  type LargeFileSortDirection,
  type LargeFileSortKey,
  type LargeFilesProgress,
  type LargeFilesResult,
  type MinimumSizeUnit,
  type VolumeInfo,
} from "@/lib/systools/large-files";
import { formatBytes, formatCount } from "@/lib/systools/format";
import { PermanentDeleteDialog } from "../components/common/permanent-delete-dialog";
import { LargeFileList } from "../components/large-files/file-list";
import { ScanProgressStrip, ScanProgressView } from "../components/common/scan-progress";
import { SortMenu } from "../components/large-files/sort-menu";
import { LargeFilesToolbar } from "../components/large-files/toolbar";

const EMPTY_ENTRIES: LargeFileEntry[] = [];

/** Default threshold in the unit shown by the input. */
const DEFAULT_MINIMUM_MB = String(LARGE_FILE_DEFAULT_MINIMUM_BYTES / (1024 * 1024));

function largeFilesScanNumbers(progress: LargeFilesProgress | null) {
  const completed = progress?.completedSteps ?? 0;
  const total = progress?.totalSteps ?? 0;
  return {
    scanned: progress?.itemsScanned ?? 0,
    found: progress?.foundItems ?? 0,
    foundBytes: progress?.foundBytes ?? 0,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
    determinate: total > 0,
  };
}

/** The largest files under the chosen roots. */
export function LargeFilesTab() {
  const { t, language } = useAppTranslation();

  const [roots, setRoots] = useState<string[]>([]);
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [minimumValue, setMinimumValue] = useState(DEFAULT_MINIMUM_MB);
  const [minimumUnit, setMinimumUnit] = useState<MinimumSizeUnit>("mb");
  const [scanMode, setScanMode] = useState<LargeFileScanMode>(LARGE_FILE_DEFAULT_SCAN_MODE);

  const [result, setResult] = useState<LargeFilesResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<LargeFilesProgress | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cancelledNotice, setCancelledNotice] = useState(false);

  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [sortKey, setSortKey] = useState<LargeFileSortKey>("size");
  const [sortDirection, setSortDirection] = useState<LargeFileSortDirection>("desc");
  const [pendingDelete, setPendingDelete] = useState<LargeFileEntry[] | null>(null);

  const scanVersion = useRef(0);
  const filterVersion = useRef(0);
  // Exclusions are user-wide prefs; loading them once keeps a scan from
  // reading settings that changed underneath an in-flight run.
  const prefs = useRef<SystoolsPrefs>({ excludedPaths: [], excludedNames: [] });
  // Threshold that the visible result was produced with. Filtering only runs
  // when the input moves away from it, which also prevents a clamp loop.
  const requestedMinimum = useRef(LARGE_FILE_MINIMUM_FLOOR_BYTES);

  const parsedMinimum = Number(minimumValue);
  const minimumValid = Number.isFinite(parsedMinimum) && parsedMinimum > 0;
  const minimumBytes = minimumSizeBytes(parsedMinimum, minimumUnit);
  const busy = filtering || deleting;

  const entries = result?.entries ?? EMPTY_ENTRIES;
  const sortedEntries = useMemo(
    () => sortLargeFiles(entries, sortKey, sortDirection),
    [entries, sortKey, sortDirection]
  );
  const selection = useMemo(
    () => selectionSummary(entries, selectedPaths),
    [entries, selectedPaths]
  );

  // The native scan reports throttled traversal progress, so the bar advances
  // even though the command promise only settles once every root is done.
  useEffect(() => {
    const unlisten = listen<LargeFilesProgress>(LARGE_FILES_PROGRESS_EVENT, (event) => {
      setProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // The last progress event can be seconds old while a large directory is read,
  // so the clock ticks locally instead of trusting the reported elapsed value.
  useEffect(() => {
    if (!scanning) return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [scanning]);

  // A rescan keeps a previous result visible until the new one arrives.
  useEffect(() => {
    // Any newer threshold request wins; an older response is discarded.
    const version = ++filterVersion.current;
    if (!result || scanning || !minimumValid || requestedMinimum.current === minimumBytes) {
      setFiltering(false);
      return;
    }

    // Threshold changes are served from the retained scan snapshot and stay
    // server-side, so no row is filtered locally.
    requestedMinimum.current = minimumBytes;
    setFiltering(true);
    const scanId = result.scanId;
    const timer = window.setTimeout(() => {
      void filterLargeFiles(scanId, minimumBytes)
        .then((next) => {
          if (version !== filterVersion.current) return;
          setResult(next);
          setSelectedPaths((current) => pruneLargeFileSelection(current, next));
        })
        .catch((error) => {
          if (version !== filterVersion.current) return;
          toast.error(t(largeFilesErrorKey(error)));
        })
        .finally(() => {
          if (version === filterVersion.current) setFiltering(false);
        });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [minimumBytes, minimumValid, result, scanning, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Load prefs before publishing the default root: the root enables Scan,
      // so a faster load would let the first scan run without exclusions.
      try {
        const loaded = await loadLargeFilePrefs();
        if (!cancelled) prefs.current = loaded;
      } catch {
        // Scanning without exclusions is still correct; the user can retry.
      }
      try {
        const nextVolumes = await listVolumes(false);
        if (!cancelled) setVolumes(nextVolumes);
      } catch {
        // Drives are a convenience; the user can still browse for a folder.
      }
      try {
        const disk = await systemDisk();
        if (!cancelled && disk.mountPoint) {
          setRoots((current) => (current.length ? current : uniqueRoots([disk.mountPoint])));
        }
      } catch {
        // Same as above: scanning simply starts without a default root.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runScan() {
    if (scanning || !roots.length) return;
    const version = ++scanVersion.current;
    // A threshold refresh of the previous result must not land mid-scan.
    ++filterVersion.current;
    setFiltering(false);
    setScanning(true);
    setCancelling(false);
    setCancelledNotice(false);
    setScanError(null);
    setProgress(null);
    const requestedBytes = minimumBytes;

    try {
      const resolved = await resolveExistingDirectories(roots);
      if (version !== scanVersion.current) return;
      if (resolved.length === 0) {
        const message = t("systools.largeFiles.errors.invalidRoots");
        setScanError(message);
        toast.error(message);
        return;
      }
      setRoots(uniqueRoots(resolved));

      const next = await scanLargeFiles(resolved, requestedBytes, scanMode, prefs.current);
      if (version !== scanVersion.current) return;
      setResult(next);
      setScanMode(next.scanMode);
      setSelectedPaths(new Set());
      requestedMinimum.current = requestedBytes;
      toast.success(
        t("systools.largeFiles.toast.scanComplete", {
          files: formatCount(next.totalCount, language),
          bytes: formatBytes(next.totalBytes, language),
        })
      );
    } catch (error) {
      if (version !== scanVersion.current) return;
      if (isLargeFilesCancellation(error)) {
        setCancelledNotice(true);
      } else {
        const message = t(largeFilesErrorKey(error));
        setScanError(message);
        toast.error(message);
      }
    } finally {
      if (version === scanVersion.current) {
        setScanning(false);
        setCancelling(false);
        setProgress(null);
      }
    }
  }

  async function cancelScan() {
    if (!scanning || cancelling) return;
    setCancelling(true);
    try {
      await cancelLargeFilesScan();
    } catch (error) {
      toast.error(t(largeFilesErrorKey(error)));
      setCancelling(false);
    }
  }

  async function addFolder() {
    try {
      const picked = await pickDirectory({
        directory: true,
        multiple: true,
        title: t("systools.largeFiles.roots.pickTitle"),
      });
      if (!picked) return;
      const folders = Array.isArray(picked) ? picked : [picked];
      setRoots((current) => uniqueRoots([...current, ...folders]));
    } catch (error) {
      toast.error(t(largeFilesErrorKey(error)));
    }
  }

  async function openEntry(entry: LargeFileEntry) {
    try {
      await openLargeFile(entry.path);
    } catch (error) {
      toast.error(t(largeFilesErrorKey(error)));
    }
  }

  async function revealEntry(entry: LargeFileEntry) {
    try {
      await revealLargeFile(entry.path);
    } catch (error) {
      toast.error(t(largeFilesErrorKey(error)));
    }
  }

  function requestDelete(entriesToDelete: LargeFileEntry[]) {
    if (!entriesToDelete.length || busy || scanning) return;
    setPendingDelete(entriesToDelete);
  }

  async function confirmDelete() {
    if (!result || !pendingDelete?.length || deleting) return;
    const scanId = result.scanId;
    const sourceMinimum = result.minimumBytes;
    const removedPaths = pendingDelete.map((entry) => entry.path);
    // Hold back a threshold refresh of the same snapshot while deleting.
    ++filterVersion.current;
    setFiltering(false);
    setDeleting(true);

    try {
      const outcome = await deleteLargeFiles(scanId, removedPaths);
      const removed = new Set([...outcome.removedPaths, ...(outcome.alreadyAbsentPaths ?? [])]);
      const failedCount = outcome.failed.length;

      // Refresh from the scan snapshot first, then reconcile the removed paths
      // so a deleted row can never reappear while the session is alive.
      let refreshed: LargeFilesResult | null = null;
      try {
        refreshed = await filterLargeFiles(scanId, sourceMinimum);
      } catch {
        refreshed = null;
      }
      requestedMinimum.current = sourceMinimum;
      setResult((current) => {
        const base = refreshed ?? current;
        return base ? removeLargeFilePaths(base, removed) : base;
      });
      setSelectedPaths((current) => setLargeFilesSelected(current, [...removed], false));
      setPendingDelete(null);

      if (outcome.removedPaths.length > 0 && failedCount === 0) {
        toast.success(
          t("systools.largeFiles.toast.deleteComplete", {
            files: formatCount(outcome.removedPaths.length, language),
            bytes: formatBytes(outcome.releasedBytes, language),
          })
        );
      } else if (outcome.removedPaths.length > 0) {
        toast.warning(
          t("systools.largeFiles.toast.deletePartial", {
            files: formatCount(outcome.removedPaths.length, language),
            failed: formatCount(failedCount, language),
            bytes: formatBytes(outcome.releasedBytes, language),
          })
        );
      } else {
        toast.error(
          t("systools.largeFiles.toast.deleteFailed", {
            failed: formatCount(failedCount, language),
          })
        );
      }
    } catch (error) {
      toast.error(t(largeFilesErrorKey(error)));
    } finally {
      setDeleting(false);
    }
  }

  const scanningEmpty = scanning && result === null;
  const resetKey = result
    ? `${result.scanId}:${result.minimumBytes}:${sortKey}:${sortDirection}`
    : `${sortKey}:${sortDirection}`;

  const scanNumbers = largeFilesScanNumbers(progress);
  const scanPath = progress?.currentPath || t("systools.largeFiles.scanning.waiting");
  const pendingEntries = pendingDelete ?? EMPTY_ENTRIES;
  const pendingBytes = pendingEntries.reduce((total, entry) => total + entry.bytes, 0);
  const scanStats = [
    {
      label: t("systools.largeFiles.scanning.scanned"),
      value: formatCount(scanNumbers.scanned, language),
    },
    {
      label: t("systools.largeFiles.scanning.found"),
      value: `${formatCount(scanNumbers.found, language)} · ${formatBytes(scanNumbers.foundBytes, language)}`,
    },
    {
      label: t("systools.largeFiles.scanning.elapsed"),
      value: t("systools.largeFiles.scanning.seconds", { seconds: elapsedSeconds }),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LargeFilesToolbar
        roots={roots}
        volumes={volumes}
        minimumValue={minimumValue}
        minimumUnit={minimumUnit}
        scanMode={scanMode}
        hasResult={result !== null}
        scanning={scanning}
        cancelling={cancelling}
        busy={busy}
        onMinimumValueChange={setMinimumValue}
        onMinimumUnitChange={setMinimumUnit}
        onScanModeChange={setScanMode}
        onAddFolder={() => void addFolder()}
        onAddDrive={(mountPoint) => setRoots((current) => uniqueRoots([...current, mountPoint]))}
        onRemoveRoot={(path) => setRoots((current) => current.filter((root) => root !== path))}
        onScan={() => void runScan()}
        onCancel={() => void cancelScan()}
      />

      {scanning && result !== null && (
        <ScanProgressStrip
          title={t("systools.largeFiles.scanning.title")}
          currentPath={scanPath}
          summary={`${formatCount(scanNumbers.scanned, language)} · ${formatCount(
            scanNumbers.found,
            language
          )} · ${t("systools.largeFiles.scanning.seconds", { seconds: elapsedSeconds })}`}
          percent={scanNumbers.percent}
          determinate={scanNumbers.determinate}
          cancelling={cancelling}
          cancelLabel={t("systools.largeFiles.actions.cancelScan")}
          cancellingLabel={t("systools.largeFiles.actions.cancelling")}
          onCancel={() => void cancelScan()}
        />
      )}

      {cancelledNotice && (
        <div
          role="status"
          className="bg-muted/40 mx-3 mt-2 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
        >
          <AlertTriangle className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {result
              ? t("systools.largeFiles.notices.cancelledWithResults")
              : t("systools.largeFiles.notices.cancelled")}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("systools.largeFiles.notices.dismiss")}
            onClick={() => setCancelledNotice(false)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {scanError && !scanning && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive mx-3 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1">{scanError}</span>
          <Button variant="ghost" size="xs" onClick={() => void runScan()}>
            {t("systools.common.retry")}
          </Button>
        </div>
      )}

      {scanningEmpty ? (
        <ScanProgressView
          title={t("systools.largeFiles.scanning.title")}
          label={t("systools.largeFiles.scanning.label")}
          currentPath={scanPath}
          percent={scanNumbers.percent}
          determinate={scanNumbers.determinate}
          cancelling={cancelling}
          cancelLabel={t("systools.largeFiles.actions.cancelScan")}
          cancellingLabel={t("systools.largeFiles.actions.cancelling")}
          description={t("systools.largeFiles.scanning.description")}
          stats={scanStats}
          onCancel={() => void cancelScan()}
        />
      ) : result === null ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
            <HardDrive className="size-6" />
          </div>
          <div className="space-y-1">
            <h2 className="text-sm font-medium">{t("systools.largeFiles.empty.title")}</h2>
            <p className="text-muted-foreground max-w-md text-sm">
              {t("systools.largeFiles.empty.description")}
            </p>
          </div>
          <Button size="sm" onClick={() => void runScan()} disabled={!roots.length || busy}>
            {scanError ? <RefreshCw className="size-4" /> : <ScanSearch className="size-4" />}
            {t("systools.largeFiles.actions.scan")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
            <span className="font-medium">
              {t("systools.largeFiles.summary.count", {
                files: formatCount(result.totalCount, language),
                size: formatBytes(result.minimumBytes, language),
              })}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {t("systools.largeFiles.summary.totalSize", {
                bytes: formatBytes(result.totalBytes, language),
              })}
            </span>
            {result.truncated ? (
              <span className="text-muted-foreground">
                {t("systools.largeFiles.summary.truncated", {
                  shown: formatCount(result.returnedCount, language),
                })}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t("systools.largeFiles.summary.returned", {
                  shown: formatCount(result.returnedCount, language),
                  total: formatCount(result.totalCount, language),
                })}
              </span>
            )}
            {result.skippedCount > 0 && (
              <span className="text-muted-foreground">
                {t("systools.largeFiles.summary.skipped", {
                  files: formatCount(result.skippedCount, language),
                })}
              </span>
            )}
            {filtering && (
              <span className="text-muted-foreground">
                {t("systools.largeFiles.summary.filtering")}
              </span>
            )}
            <div className="ml-auto">
              <SortMenu
                sortKey={sortKey}
                direction={sortDirection}
                onSortKeyChange={(next) => {
                  setSortKey(next);
                  setSortDirection(next === "size" ? "desc" : "asc");
                }}
                onDirectionChange={setSortDirection}
              />
            </div>
          </div>

          {sortedEntries.length > 0 ? (
            <LargeFileList
              entries={sortedEntries}
              selectedPaths={selectedPaths}
              selection={selection}
              disabled={busy || scanning}
              resetKey={resetKey}
              language={language}
              onToggle={(path, selected) =>
                setSelectedPaths((current) => setLargeFilesSelected(current, [path], selected))
              }
              onToggleAll={(selected) =>
                setSelectedPaths((current) =>
                  setLargeFilesSelected(
                    current,
                    entries.map((entry) => entry.path),
                    selected
                  )
                )
              }
              onOpen={(entry) => void openEntry(entry)}
              onReveal={(entry) => void revealEntry(entry)}
              onDelete={(entry) => requestDelete([entry])}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <SearchX className="text-muted-foreground size-8" aria-hidden="true" />
              <p className="text-sm font-medium">{t("systools.largeFiles.empty.resultTitle")}</p>
              <p className="text-muted-foreground max-w-sm text-xs">
                {t("systools.largeFiles.empty.resultDescription", {
                  size: formatBytes(result.minimumBytes, language),
                })}
              </p>
            </div>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
            <span className="text-xs">
              {t("systools.largeFiles.selection.count", {
                files: formatCount(selection.count, language),
              })}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("systools.largeFiles.selection.size", {
                bytes: formatBytes(selection.bytes, language),
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={selection.count === 0}
              onClick={() => setSelectedPaths(new Set())}
            >
              {t("systools.largeFiles.selection.clear")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="ml-auto"
              disabled={selection.count === 0 || busy || scanning}
              onClick={() => requestDelete(selectedLargeFiles(entries, selectedPaths))}
            >
              <Trash2 className="size-4" />
              {t("systools.largeFiles.actions.deleteSelected")}
            </Button>
          </div>
        </>
      )}

      <PermanentDeleteDialog
        open={pendingDelete !== null}
        busy={deleting}
        title={t("systools.largeFiles.delete.title")}
        description={t("systools.largeFiles.delete.description")}
        stats={[
          {
            label: t("systools.largeFiles.delete.filesLabel"),
            value: formatCount(pendingEntries.length, language),
          },
          {
            label: t("systools.largeFiles.delete.sizeLabel"),
            value: formatBytes(pendingBytes, language),
          },
        ]}
        preview={
          <p className="text-muted-foreground max-h-24 overflow-y-auto text-[11px] leading-relaxed break-all">
            {pendingEntries.length === 1
              ? pendingEntries[0]?.path
              : t("systools.largeFiles.delete.previewPaths", {
                  first: pendingEntries[0]?.path ?? "",
                  count: Math.max(0, pendingEntries.length - 1),
                })}
          </p>
        }
        warning={t("systools.largeFiles.delete.note")}
        cancelLabel={t("systools.common.cancel")}
        busyLabel={t("systools.largeFiles.delete.deleting")}
        confirmLabel={t("systools.largeFiles.delete.confirm")}
        confirmDisabled={pendingEntries.length === 0}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
