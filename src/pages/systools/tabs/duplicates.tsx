import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Copy, Loader2, SearchX, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ScanNameExclusion } from "@/commands/services/systools/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes } from "@/lib/systools/format";
import {
  cancelDuplicateScan,
  DEFAULT_DUPLICATE_KEEPER_RULE,
  DEFAULT_DUPLICATE_MINIMUM_AMOUNT,
  DEFAULT_DUPLICATE_MINIMUM_UNIT,
  deleteDuplicates,
  DUPLICATE_GROUPS_EVENT,
  DUPLICATE_PAGE_SIZE,
  DUPLICATE_PROGRESS_EVENT,
  duplicateErrorKey,
  duplicateGroupLabels,
  duplicateMinimumBytes,
  duplicatePathKey,
  duplicateProgressPercent,
  duplicateScanStageKey,
  isDuplicateCancellation,
  listDuplicateVolumes,
  loadDuplicatePrefs,
  mergeDuplicateGroups,
  openDuplicateFile,
  pageDuplicates,
  removeDuplicatePaths,
  revealDuplicateEntry,
  scanDuplicates,
  selectedDuplicateEntries,
  suggestedPaths,
  systemDuplicateVolume,
  toggleGroupSelection,
  totalAllocatedBytes,
  updateEntrySelection,
  type DuplicateFileEntry,
  type DuplicateGroup,
  type DuplicateGroupBatch,
  type DuplicateKeeperRule,
  type DuplicateScanLocation,
  type DuplicateScanProgress,
  type DuplicateSizeUnit,
  type DuplicateVolume,
} from "@/lib/systools/duplicates";
import { cn } from "@/lib/utils";
import { PermanentDeleteDialog } from "../components/common/permanent-delete-dialog";
import { DuplicateGroupList } from "../components/duplicates/group-list";
import { DuplicateScanControls } from "../components/duplicates/scan-controls";
import { DuplicateSmartSelect } from "../components/duplicates/smart-select";

type Phase = "idle" | "scanning" | "ready";

/** Result counters; `scanId` is only authoritative once the native scan settles. */
type DuplicateView = {
  scanId: number;
  totalGroupCount: number;
  duplicateFileCount: number;
  totalDuplicateBytes: number;
  reclaimableBytes: number;
  scannedFileCount: number;
  skippedCount: number;
  truncated: boolean;
};

/** Files with identical content found across the chosen locations. */
export function DuplicatesTab() {
  const { t, language } = useAppTranslation();

  const [locations, setLocations] = useState<DuplicateScanLocation[]>([]);
  const [minimumAmount, setMinimumAmount] = useState(String(DEFAULT_DUPLICATE_MINIMUM_AMOUNT));
  const [minimumUnit, setMinimumUnit] = useState<DuplicateSizeUnit>(DEFAULT_DUPLICATE_MINIMUM_UNIT);
  const [volumes, setVolumes] = useState<DuplicateVolume[]>([]);
  const [excludedPaths, setExcludedPaths] = useState<string[]>([]);
  const [excludedNames, setExcludedNames] = useState<ScanNameExclusion[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<DuplicateScanProgress | null>(null);
  const [view, setView] = useState<DuplicateView | null>(null);
  const [groups, setGroups] = useState<readonly DuplicateGroup[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [keeperRule, setKeeperRule] = useState<DuplicateKeeperRule>(DEFAULT_DUPLICATE_KEEPER_RULE);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [listEpoch, setListEpoch] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [complete, setComplete] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** A right-click delete targets one copy instead of the whole selection. */
  const [pendingDelete, setPendingDelete] = useState<DuplicateFileEntry[] | null>(null);

  const initialized = useRef(false);
  const scanVersion = useRef(0);
  const scanIdRef = useRef<number | null>(null);
  const operationId = useRef<number | null>(null);
  const lastSequence = useRef(0);
  const groupsRef = useRef<readonly DuplicateGroup[]>([]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  const minimumBytes = useMemo(
    () => duplicateMinimumBytes(Number(minimumAmount.replace(",", ".")), minimumUnit),
    [minimumAmount, minimumUnit]
  );
  const scanning = phase === "scanning";
  const canScan = locations.length > 0 && minimumBytes > 0 && !deleting;
  const minimumLabel = formatBytes(minimumBytes, language);

  const selectedEntries = useMemo(
    () => selectedDuplicateEntries(groups, selected),
    [groups, selected]
  );
  const selectedBytes = useMemo(() => totalAllocatedBytes(selectedEntries), [selectedEntries]);
  // A right-click delete confirms only the copy under the cursor.
  const deleteTargets = pendingDelete ?? selectedEntries;
  const deleteBytes = useMemo(
    () => (pendingDelete ? totalAllocatedBytes(pendingDelete) : selectedBytes),
    [pendingDelete, selectedBytes]
  );
  const labels = useMemo(() => duplicateGroupLabels(groups), [groups]);

  // A rescan changes path policies; drop selections that no longer qualify.
  useEffect(() => {
    setSelected((previous) => {
      if (!previous.size) return previous;
      const available = new Set<string>();
      for (const group of groups) {
        for (const entry of group.entries) {
          if (entry.deletePolicy === "cleanable") available.add(entry.path);
        }
      }
      let changed = false;
      const next = new Set<string>();
      for (const path of previous) {
        if (available.has(path)) next.add(path);
        else changed = true;
      }
      return changed ? next : previous;
    });
  }, [groups]);

  async function initialize() {
    const [prefs, volumeList, system] = await Promise.allSettled([
      loadDuplicatePrefs(),
      listDuplicateVolumes(),
      systemDuplicateVolume(),
    ]);
    if (prefs.status === "fulfilled") {
      setExcludedPaths(prefs.value.excludedPaths);
      setExcludedNames(prefs.value.excludedNames);
    }
    if (volumeList.status === "fulfilled") setVolumes(volumeList.value);
    if (system.status === "fulfilled" && system.value?.mountPoint) {
      const mountPoint = system.value.mountPoint;
      setLocations((previous) =>
        previous.length ? previous : [{ path: mountPoint, mode: "cleanable" }]
      );
    }
  }

  useEffect(() => {
    // A ref guard keeps React 19's development double-invoke from loading twice.
    if (initialized.current) return;
    initialized.current = true;
    void initialize();
  }, []);

  function addLocation(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    setLocations((previous) => {
      const key = duplicatePathKey(trimmed);
      if (previous.some((location) => duplicatePathKey(location.path) === key)) return previous;
      return [...previous, { path: trimmed, mode: "cleanable" }];
    });
  }

  function removeLocation(path: string) {
    const key = duplicatePathKey(path);
    setLocations((previous) =>
      previous.filter((location) => duplicatePathKey(location.path) !== key)
    );
  }

  function toggleLocationMode(path: string) {
    const key = duplicatePathKey(path);
    setLocations((previous) =>
      previous.map((location) =>
        duplicatePathKey(location.path) === key
          ? { ...location, mode: location.mode === "protected" ? "cleanable" : "protected" }
          : location
      )
    );
  }

  async function addFolder() {
    try {
      const chosen = await pickDirectory({
        directory: true,
        multiple: true,
        title: t("systools.duplicates.actions.addFolder"),
      });
      if (!chosen) return;
      for (const path of Array.isArray(chosen) ? chosen : [chosen]) addLocation(path);
    } catch (error) {
      toast.error(t("systools.duplicates.toast.folderPickerFailed"), {
        description: t(duplicateErrorKey(error)),
      });
    }
  }

  async function runScan() {
    if (scanning || deleting || !canScan) return;

    const version = ++scanVersion.current;
    const requestedLocations = locations.map((location) => ({ ...location }));
    const requestedMinimum = minimumBytes;
    const requestedExcludedPaths = excludedPaths;
    const requestedExcludedNames = excludedNames;

    setPhase("scanning");
    setCancelling(false);
    setProgress(null);
    setScanError(null);
    setCancelled(false);
    setComplete(false);
    setView(null);
    setGroups([]);
    setNextOffset(null);
    setListEpoch((previous) => previous + 1);
    setSelected(new Set());
    setExpanded(new Set());
    scanIdRef.current = null;
    operationId.current = null;
    lastSequence.current = -1;

    const unlisteners: Array<() => void> = [];
    try {
      unlisteners.push(
        await listen<DuplicateScanProgress>(DUPLICATE_PROGRESS_EVENT, (event) => {
          if (version !== scanVersion.current) return;
          const payload = event.payload;
          if (operationId.current === null) operationId.current = payload.operationId;
          if (payload.operationId !== operationId.current) return;
          setProgress(payload);
        })
      );
      unlisteners.push(
        await listen<DuplicateGroupBatch>(DUPLICATE_GROUPS_EVENT, (event) => {
          if (version !== scanVersion.current) return;
          const batch = event.payload;
          if (operationId.current === null) operationId.current = batch.operationId;
          if (batch.operationId !== operationId.current) return;
          if (batch.sequence <= lastSequence.current) return;
          lastSequence.current = batch.sequence;
          setGroups((previous) => mergeDuplicateGroups(previous, batch.groups));
          setView({
            scanId: batch.operationId,
            totalGroupCount: batch.foundGroupCount,
            duplicateFileCount: batch.foundFileCount,
            totalDuplicateBytes: batch.foundTotalBytes,
            reclaimableBytes: batch.foundReclaimableBytes,
            scannedFileCount: 0,
            skippedCount: 0,
            truncated: false,
          });
        })
      );

      const result = await scanDuplicates(
        requestedLocations,
        requestedMinimum,
        requestedExcludedPaths,
        requestedExcludedNames
      );
      if (version !== scanVersion.current) return;

      scanIdRef.current = result.scanId;
      setGroups(result.groups);
      setView({
        scanId: result.scanId,
        totalGroupCount: result.totalGroupCount,
        duplicateFileCount: result.duplicateFileCount,
        totalDuplicateBytes: result.totalDuplicateBytes,
        reclaimableBytes: result.reclaimableBytes,
        scannedFileCount: result.scannedFileCount,
        skippedCount: result.skippedCount,
        truncated: result.truncated,
      });
      setComplete(true);
      setNextOffset(result.totalGroupCount > result.groups.length ? result.groups.length : null);
      setPhase("ready");
    } catch (error) {
      if (version !== scanVersion.current) return;
      if (isDuplicateCancellation(error)) {
        // Groups streamed before the cancel remain listed but cannot authorize
        // a delete: the native session may not hold them any more.
        setCancelled(true);
        setComplete(false);
        setNextOffset(null);
        toast.info(t("systools.duplicates.toast.scanCancelled"));
      } else {
        const message = t(duplicateErrorKey(error));
        setScanError(message);
        setComplete(false);
        setNextOffset(null);
        toast.error(t("systools.duplicates.toast.scanFailed"), { description: message });
      }
      setPhase("ready");
    } finally {
      for (const off of unlisteners) off();
      if (version === scanVersion.current) {
        setCancelling(false);
        setProgress(null);
        setPhase((previous) => (previous === "scanning" ? "ready" : previous));
      }
    }
  }

  async function cancelScan() {
    if (!scanning || cancelling) return;
    setCancelling(true);
    try {
      await cancelDuplicateScan();
    } catch (error) {
      setCancelling(false);
      toast.error(t("systools.duplicates.toast.cancelFailed"), {
        description: t(duplicateErrorKey(error)),
      });
    }
  }

  async function loadMore() {
    const sourceId = scanIdRef.current;
    if (sourceId === null || nextOffset === null || loadingMore || scanning || deleting) return;
    const offset = nextOffset;
    setLoadingMore(true);
    try {
      const page = await pageDuplicates(sourceId, offset, DUPLICATE_PAGE_SIZE);
      if (scanIdRef.current !== sourceId) return;
      setGroups((previous) => mergeDuplicateGroups(previous, page.groups));
      setNextOffset(page.nextOffset);
      setView((previous) =>
        previous ? { ...previous, totalGroupCount: page.totalCount } : previous
      );
    } catch (error) {
      if (scanIdRef.current !== sourceId) return;
      toast.error(t("systools.duplicates.toast.pageFailed"), {
        description: t(duplicateErrorKey(error)),
      });
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Re-reads the loaded pages so the counts reflect what the native session
   * kept. Deleted paths are filtered again in case a page still lists them.
   */
  async function reloadGroups(removed: ReadonlySet<string>) {
    const sourceId = scanIdRef.current;
    if (sourceId === null) return;
    const target = Math.max(groupsRef.current.length, DUPLICATE_PAGE_SIZE);
    let offset: number | null = 0;
    let collected: readonly DuplicateGroup[] = [];
    let totalCount = 0;
    try {
      while (offset !== null && collected.length < target) {
        const page = await pageDuplicates(sourceId, offset, DUPLICATE_PAGE_SIZE);
        if (scanIdRef.current !== sourceId) return;
        collected = mergeDuplicateGroups(collected, page.groups);
        totalCount = page.totalCount;
        offset = page.nextOffset;
      }
    } catch (error) {
      if (scanIdRef.current !== sourceId) return;
      toast.error(t("systools.duplicates.toast.refreshFailed"), {
        description: t(duplicateErrorKey(error)),
      });
      return;
    }
    setGroups(removeDuplicatePaths(collected, removed));
    setNextOffset(offset);
    setView((previous) => (previous ? { ...previous, totalGroupCount: totalCount } : previous));
  }

  async function confirmDelete() {
    const sourceId = scanIdRef.current;
    const targets = pendingDelete ?? selectedEntries;
    if (sourceId === null || !targets.length || deleting || !complete) return;

    setDeleting(true);
    try {
      const outcome = await deleteDuplicates(
        sourceId,
        targets.map((entry: DuplicateFileEntry) => ({
          path: entry.path,
          expectedBytes: entry.bytes,
          expectedModifiedAtMs: entry.modifiedAtMs,
        }))
      );
      if (scanIdRef.current !== sourceId) return;

      const removed = new Set<string>([
        ...outcome.removedPaths,
        ...(outcome.alreadyAbsentPaths ?? []),
      ]);
      const failed = outcome.failed.length;
      const released = formatBytes(outcome.releasedBytes, language);

      if (failed === 0) {
        toast.success(
          t("systools.duplicates.toast.deleted", {
            count: outcome.removedPaths.length,
            bytes: released,
          })
        );
      } else if (outcome.removedPaths.length === 0) {
        toast.error(t("systools.duplicates.toast.deleteFailed", { count: failed }));
      } else {
        toast.warning(
          t("systools.duplicates.toast.deletedPartial", {
            count: outcome.removedPaths.length,
            failed,
            bytes: released,
          })
        );
      }

      setConfirmOpen(false);
      setPendingDelete(null);
      // A right-click delete removes one copy; keep the rest of the selection.
      setSelected((previous) => {
        if (!removed.size) return previous;
        const next = new Set(previous);
        for (const path of removed) next.delete(path);
        return next.size === previous.size ? previous : next;
      });
      if (removed.size > 0) {
        setGroups((previous) => removeDuplicatePaths(previous, removed));
        await reloadGroups(removed);
      }
    } catch (error) {
      if (scanIdRef.current !== sourceId) return;
      toast.error(t("systools.duplicates.toast.deleteError"), {
        description: t(duplicateErrorKey(error)),
      });
    } finally {
      setDeleting(false);
    }
  }

  async function openEntry(entry: DuplicateFileEntry) {
    try {
      await openDuplicateFile(entry.path);
    } catch (error) {
      toast.error(t("systools.duplicates.toast.openFailed"), {
        description: t(duplicateErrorKey(error)),
      });
    }
  }

  async function revealEntry(entry: DuplicateFileEntry) {
    try {
      await revealDuplicateEntry(entry.path);
    } catch (error) {
      toast.error(t("systools.duplicates.toast.openFailed"), {
        description: t(duplicateErrorKey(error)),
      });
    }
  }

  function requestDelete(entries: DuplicateFileEntry[]) {
    if (!entries.length || scanning || deleting || !complete) return;
    setPendingDelete(entries);
    setConfirmOpen(true);
  }

  function toggleExpanded(groupId: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function toggleGroup(group: DuplicateGroup) {
    setSelected((previous) => toggleGroupSelection(previous, group, keeperRule));
  }

  function toggleEntry(group: DuplicateGroup, entry: DuplicateFileEntry, selectedNow: boolean) {
    setSelected((previous) => updateEntrySelection(previous, entry, group, selectedNow));
  }

  function toggleSmartSelection() {
    if (scanning || deleting || !groups.length) return;
    if (selectedEntries.length > 0) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(suggestedPaths(groups, keeperRule)));
  }

  function changeKeeperRule(rule: DuplicateKeeperRule) {
    setKeeperRule(rule);
    if (!scanning && !deleting) setSelected(new Set(suggestedPaths(groups, rule)));
  }

  const hasResult = view !== null;
  const progressPercent = duplicateProgressPercent(progress);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <DuplicateScanControls
          locations={locations}
          minimumAmount={minimumAmount}
          minimumUnit={minimumUnit}
          volumes={volumes}
          scanning={scanning}
          cancelling={cancelling}
          busy={deleting}
          canScan={canScan}
          hasResult={hasResult}
          excludedPathCount={excludedPaths.length}
          excludedNameCount={excludedNames.length}
          onMinimumAmountChange={setMinimumAmount}
          onMinimumUnitChange={setMinimumUnit}
          onAddFolder={() => void addFolder()}
          onAddVolume={addLocation}
          onRemoveLocation={removeLocation}
          onToggleLocationMode={toggleLocationMode}
          onScan={() => void runScan()}
          onCancel={() => void cancelScan()}
        />

        {scanning && (
          <div className="shrink-0 border-b px-3 py-1.5" aria-busy="true">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="shrink-0 font-medium">
                {t("systools.duplicates.scanning.title")}
              </span>
              <span className="text-muted-foreground truncate">
                {t(duplicateScanStageKey(progress?.currentStage ?? null))}
              </span>
              <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
                {t("systools.duplicates.scanning.stats", {
                  files: (progress?.itemsScanned ?? 0).toLocaleString(language),
                  read: formatBytes(progress?.bytesScanned ?? 0, language),
                  groups: view?.totalGroupCount ?? 0,
                })}
              </span>
            </div>
            <Progress
              value={progressPercent}
              className={cn("mt-1 h-0.5", progressPercent === 0 && "animate-pulse")}
            />
            {progress?.currentPath ? (
              <p className="text-muted-foreground mt-0.5 truncate text-[10px]">
                {progress.currentPath}
              </p>
            ) : null}
          </div>
        )}

        {cancelled && (
          <div
            role="status"
            className="border-border bg-muted/40 text-muted-foreground mx-3 mt-2 flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{t("systools.duplicates.cancelledBanner")}</span>
          </div>
        )}

        {scanError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mx-3 mt-2 flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{scanError}</span>
            <Button variant="ghost" size="xs" onClick={() => void runScan()} disabled={!canScan}>
              {t("systools.common.retry")}
            </Button>
          </div>
        )}

        {hasResult && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs">
            <span className="font-medium">
              {t("systools.duplicates.summary.groups", { count: view.totalGroupCount })}
            </span>
            <span className="text-muted-foreground">
              {t("systools.duplicates.summary.files", { count: view.duplicateFileCount })}
            </span>
            <span className="text-muted-foreground">
              {complete
                ? t("systools.duplicates.summary.reclaimable", {
                    bytes: formatBytes(view.reclaimableBytes, language),
                  })
                : t("systools.duplicates.summary.reclaimableScanning", {
                    bytes: formatBytes(view.reclaimableBytes, language),
                  })}
            </span>
            {view.skippedCount > 0 && (
              <span className="text-muted-foreground">
                {t("systools.duplicates.summary.skipped", { count: view.skippedCount })}
              </span>
            )}
            <div className="ml-auto">
              <DuplicateSmartSelect
                rule={keeperRule}
                selectedCount={selectedEntries.length}
                disabled={!complete || scanning || deleting || groups.length === 0}
                onToggle={toggleSmartSelection}
                onRuleChange={changeKeeperRule}
              />
            </div>
          </div>
        )}

        {hasResult && complete && view.truncated && (
          <p className="text-muted-foreground shrink-0 border-b px-3 py-1 text-[11px]">
            {t("systools.duplicates.summary.truncated")}
          </p>
        )}

        {hasResult && groups.length > 0 && (
          <DuplicateGroupList
            groups={groups}
            labels={labels}
            selected={selected}
            expanded={expanded}
            keeperRule={keeperRule}
            disabled={!complete || scanning || deleting}
            resetKey={listEpoch}
            onToggleExpanded={toggleExpanded}
            onToggleGroup={toggleGroup}
            onToggleEntry={toggleEntry}
            onOpenEntry={(entry) => void openEntry(entry)}
            onRevealEntry={(entry) => void revealEntry(entry)}
            onDeleteEntry={(entry) => requestDelete([entry])}
          />
        )}

        {hasResult && groups.length === 0 && !scanning && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <SearchX className="text-muted-foreground size-8" />
            <p className="text-sm font-medium">{t("systools.duplicates.emptyResult.title")}</p>
            <p className="text-muted-foreground max-w-md text-xs">
              {t("systools.duplicates.emptyResult.description", { size: minimumLabel })}
            </p>
          </div>
        )}

        {!hasResult && scanning && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        )}

        {!hasResult && !scanning && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
              <Copy className="size-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-medium">{t("systools.duplicates.emptyIdle.title")}</h2>
              <p className="text-muted-foreground max-w-md text-sm">
                {locations.length === 0
                  ? t("systools.duplicates.locations.empty")
                  : t("systools.duplicates.emptyIdle.description")}
              </p>
            </div>
          </div>
        )}

        {hasResult && complete && nextOffset !== null && (
          <div className="flex shrink-0 justify-center border-t px-3 py-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
              {t("systools.duplicates.actions.loadMore", {
                count: Math.max(0, view.totalGroupCount - groups.length),
              })}
            </Button>
          </div>
        )}

        {hasResult && (
          <div className="bg-background flex shrink-0 items-center gap-2 border-t px-3 py-2">
            <span className="text-xs font-medium">
              {t("systools.duplicates.selection.count", { count: selectedEntries.length })}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("systools.duplicates.selection.bytes", {
                bytes: formatBytes(selectedBytes, language),
              })}
            </span>
            {!complete && (
              <span className="text-muted-foreground truncate text-[10px]">
                {t("systools.duplicates.selection.incomplete")}
              </span>
            )}
            <Button
              variant="destructive"
              size="sm"
              className="ml-auto"
              disabled={!complete || !selectedEntries.length || scanning || deleting}
              onClick={() => {
                setPendingDelete(null);
                setConfirmOpen(true);
              }}
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {t("systools.duplicates.delete.confirm")}
            </Button>
          </div>
        )}
      </div>

      <PermanentDeleteDialog
        open={confirmOpen}
        busy={deleting}
        title={
          <>
            <ShieldAlert className="text-destructive size-4 shrink-0" />
            {t("systools.duplicates.delete.title", { count: deleteTargets.length })}
          </>
        }
        description={t("systools.duplicates.delete.description", {
          count: deleteTargets.length,
          bytes: formatBytes(deleteBytes, language),
        })}
        warning={t("systools.duplicates.delete.safety")}
        cancelLabel={t("systools.common.cancel")}
        busyLabel={t("systools.duplicates.delete.deleting")}
        confirmLabel={t("systools.duplicates.delete.confirm")}
        onOpenChange={(next) => {
          setConfirmOpen(next);
          if (!next) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </TooltipProvider>
  );
}
