import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, Loader2, ScanSearch, Trash2 } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  LEFTOVERS_PROGRESS_EVENT,
  isCancellationError,
  parseSystoolsError,
  systoolsErrorKey,
  systoolsLeftoversCancel,
  systoolsLeftoversExecute,
  systoolsLeftoversScan,
  type ApplicationLeftoverCandidate,
  type ApplicationLeftoverResult,
  type ApplicationLeftoverScanProgress,
  type ApplicationLeftoverScanResult,
  type ApplicationLeftoverSource,
} from "@/lib/systools/applications";
import { formatBytes } from "@/lib/systools/format";
import { cn } from "@/lib/utils";
import { SelectionCheckbox } from "../common/selection-checkbox";

type LeftoverGroupKey = "files" | "settings" | "logs";

const GROUP_BY_SOURCE: Record<ApplicationLeftoverSource, LeftoverGroupKey> = {
  // Registry residues arrive as `preferences`; Start Menu and Desktop
  // shortcuts arrive as `applicationScripts`, so both stay grouped here.
  sandboxContainer: "files",
  applicationSupport: "files",
  savedState: "files",
  applicationScripts: "files",
  preferences: "settings",
  webData: "settings",
  logs: "logs",
};

const GROUP_ORDER: readonly LeftoverGroupKey[] = ["files", "settings", "logs"];

type LeftoverGroup = {
  key: LeftoverGroupKey;
  candidates: ApplicationLeftoverCandidate[];
  bytes: number;
};

function groupSelection(
  candidates: readonly ApplicationLeftoverCandidate[],
  selected: ReadonlySet<string>
): "none" | "partial" | "all" {
  const count = candidates.reduce(
    (total, candidate) => total + Number(selected.has(candidate.candidateId)),
    0
  );
  if (count === 0) return "none";
  return count === candidates.length ? "all" : "partial";
}

/** Collapsible leftover scan, review, and permanent-delete surface. */
export function LeftoversPanel() {
  const { t, language } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<LeftoverGroupKey>>(
    () => new Set(GROUP_ORDER)
  );
  const [scan, setScan] = useState<ApplicationLeftoverScanResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ApplicationLeftoverScanProgress | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cancellingDelete, setCancellingDelete] = useState(false);
  const [result, setResult] = useState<ApplicationLeftoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanVersion = useRef(0);

  const groups = useMemo<LeftoverGroup[]>(() => {
    const grouped = new Map<LeftoverGroupKey, LeftoverGroup>();
    for (const candidate of scan?.candidates ?? []) {
      const key = GROUP_BY_SOURCE[candidate.source];
      const group = grouped.get(key) ?? { key, candidates: [], bytes: 0 };
      group.candidates.push(candidate);
      group.bytes += candidate.bytes;
      grouped.set(key, group);
    }
    return GROUP_ORDER.flatMap((key) => {
      const group = grouped.get(key);
      return group ? [group] : [];
    });
  }, [scan]);

  const selectedCandidates = useMemo(
    () => (scan?.candidates ?? []).filter((candidate) => selectedIds.has(candidate.candidateId)),
    [scan, selectedIds]
  );

  const selectedBytes = selectedCandidates.reduce((total, candidate) => total + candidate.bytes, 0);

  useEffect(() => {
    const unlisten = listen<ApplicationLeftoverScanProgress>(LEFTOVERS_PROGRESS_EVENT, (event) => {
      setScanProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    return () => {
      scanVersion.current += 1;
    };
  }, []);

  function scanStageLabel(): string {
    switch (scanProgress?.stage) {
      case "uninstallRegistry":
        return t("systools.uninstall.leftovers.stages.uninstallRegistry");
      case "orphanRegistryGroups":
        return t("systools.uninstall.leftovers.stages.orphanRegistryGroups");
      case "dataDirectories":
        return t("systools.uninstall.leftovers.stages.dataDirectories");
      case "shortcuts":
        return t("systools.uninstall.leftovers.stages.shortcuts");
      default:
        return t("systools.uninstall.leftovers.stages.preparing");
    }
  }

  async function runScan() {
    const version = ++scanVersion.current;
    setScanning(true);
    setScanProgress(null);
    setError(null);
    setResult(null);
    setExpanded(true);
    try {
      const scanned = await systoolsLeftoversScan();
      if (version !== scanVersion.current) return;
      setScan(scanned);
      setSelectedIds(
        new Set(
          scanned.candidates
            .filter((candidate) => candidate.defaultSelected)
            .map((candidate) => candidate.candidateId)
        )
      );
      const populated = new Set<LeftoverGroupKey>();
      for (const candidate of scanned.candidates) {
        populated.add(GROUP_BY_SOURCE[candidate.source]);
      }
      setOpenGroups(populated);
    } catch (scanError) {
      if (version !== scanVersion.current) return;
      const parsed = parseSystoolsError(scanError);
      if (!parsed || !isCancellationError(parsed)) {
        setError(t(systoolsErrorKey(scanError)));
      }
    } finally {
      if (version === scanVersion.current) {
        setScanning(false);
        setCancellingScan(false);
      }
    }
  }

  async function cancelScan() {
    if (cancellingScan) return;
    setCancellingScan(true);
    try {
      await systoolsLeftoversCancel();
    } catch {
      setCancellingScan(false);
    }
  }

  function toggleCandidate(candidateId: string) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }

  function toggleGroup(group: LeftoverGroup) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      const selectAll = groupSelection(group.candidates, previous) !== "all";
      for (const candidate of group.candidates) {
        if (selectAll) next.add(candidate.candidateId);
        else next.delete(candidate.candidateId);
      }
      return next;
    });
  }

  function toggleGroupOpen(key: LeftoverGroupKey) {
    setOpenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function deleteSelected() {
    if (!selectedCandidates.length || deleting) return;
    setConfirmOpen(false);
    setDeleting(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await systoolsLeftoversExecute(
        selectedCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          expectedBytes: candidate.bytes,
          expectedFileCount: candidate.fileCount,
          expectedSnapshotFingerprint: candidate.snapshotFingerprint,
        })),
        false,
        crypto.randomUUID()
      );
      setResult(outcome);
      const removed = new Set(
        outcome.actions
          .filter((action) => action.status === "completed")
          .map((action) => action.candidateId)
      );
      if (removed.size > 0) {
        setScan((previous) => {
          if (!previous) return previous;
          const candidates = previous.candidates.filter(
            (candidate) => !removed.has(candidate.candidateId)
          );
          return {
            ...previous,
            candidates,
            totalBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
            totalFileCount: candidates.reduce((total, candidate) => total + candidate.fileCount, 0),
          };
        });
        setSelectedIds((previous) => {
          const next = new Set(previous);
          for (const candidateId of removed) next.delete(candidateId);
          return next;
        });
      }
    } catch (deleteError) {
      setError(t(systoolsErrorKey(deleteError)));
    } finally {
      setDeleting(false);
      setCancellingDelete(false);
    }
  }

  async function cancelDelete() {
    if (cancellingDelete) return;
    setCancellingDelete(true);
    try {
      await systoolsLeftoversCancel();
    } catch {
      setCancellingDelete(false);
    }
  }

  const failedActions = result?.actions.filter((action) => action.status === "failed") ?? [];

  return (
    <section className="shrink-0 border-t">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="hover:bg-muted/40 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors"
        >
          {expanded ? (
            <ChevronDown className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="text-sm font-medium">{t("systools.uninstall.leftovers.title")}</span>
          {scan && (
            <span className="text-muted-foreground truncate text-xs">
              {t("systools.uninstall.leftovers.summary", {
                count: scan.candidates.length,
                bytes: formatBytes(scan.totalBytes, language),
              })}
            </span>
          )}
        </button>

        {scanning && (
          <span className="text-muted-foreground shrink-0 truncate text-xs tabular-nums">
            {scanStageLabel()}
            {scanProgress ? ` · ${scanProgress.percent}%` : ""}
          </span>
        )}
        {scanning && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void cancelScan()}
            disabled={cancellingScan}
          >
            {cancellingScan
              ? t("systools.uninstall.leftovers.cancelling")
              : t("systools.uninstall.leftovers.cancelScan")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runScan()}
          disabled={scanning || deleting}
        >
          {scanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ScanSearch className="size-4" />
          )}
          {scanning
            ? t("systools.uninstall.leftovers.scanning")
            : scan
              ? t("systools.uninstall.leftovers.rescan")
              : t("systools.uninstall.leftovers.scan")}
        </Button>
      </div>

      {scanning && (
        <Progress
          value={scanProgress?.percent ?? 0}
          className={cn(
            "h-0.5 rounded-none",
            (scanProgress?.percent ?? 0) === 0 && "animate-pulse"
          )}
        />
      )}

      {expanded && (
        <div className="max-h-[40vh] space-y-2 overflow-y-auto border-t px-3 py-2">
          {error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
            >
              {error}
            </div>
          )}

          {scanning && !scan && (
            <div className="space-y-2" aria-busy="true">
              <p className="text-muted-foreground text-xs">{scanStageLabel()}</p>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}

          {!scan && !scanning && (
            <p className="text-muted-foreground py-3 text-xs">
              {t("systools.uninstall.leftovers.empty")}
            </p>
          )}

          {scan && (
            <>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span>
                  {t("systools.uninstall.leftovers.counts", {
                    count: scan.candidates.length,
                    files: scan.totalFileCount,
                    bytes: formatBytes(scan.totalBytes, language),
                  })}
                </span>
                {scan.skippedCount > 0 && (
                  <span>
                    {t("systools.uninstall.leftovers.skipped", { count: scan.skippedCount })}
                  </span>
                )}
                {scan.accessLimited && (
                  <span className="text-destructive">
                    {t("systools.uninstall.leftovers.accessLimited")}
                  </span>
                )}
              </div>

              {result && (
                <div
                  className={cn(
                    "rounded-md border px-3 py-2 text-[11px]",
                    failedActions.length > 0
                      ? "border-destructive/40 bg-destructive/10"
                      : "border-border bg-muted/40"
                  )}
                >
                  <p className="font-medium">
                    {t("systools.uninstall.leftovers.resultSummary", {
                      affected: result.affectedItemCount,
                      failed: result.failedItemCount,
                      bytes: formatBytes(result.releasedBytes, language),
                    })}
                  </p>
                  {failedActions.length > 0 && (
                    <ul className="text-muted-foreground mt-1 space-y-0.5">
                      {failedActions.map((action) => (
                        <li key={action.candidateId} className="truncate">
                          {action.applicationName}
                          {" · "}
                          {action.reason
                            ? t(`systools.uninstall.leftovers.reasons.${action.reason}`)
                            : t("systools.uninstall.leftovers.deleteFailed")}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {groups.length === 0 && !scanning && (
                <p className="text-muted-foreground py-2 text-xs">
                  {t("systools.uninstall.leftovers.emptyGroups")}
                </p>
              )}

              <div className="space-y-1.5">
                {groups.map((group) => {
                  const selection = groupSelection(group.candidates, selectedIds);
                  const isOpen = openGroups.has(group.key);
                  return (
                    <div key={group.key} className="rounded-md border">
                      <div className="hover:bg-muted/40 flex items-center gap-2 px-2 py-1.5 transition-colors">
                        <SelectionCheckbox
                          checked={selection === "all"}
                          indeterminate={selection === "partial"}
                          aria-label={t(`systools.uninstall.leftovers.groups.${group.key}`)}
                          onCheckedChange={() => toggleGroup(group)}
                        />
                        <button
                          type="button"
                          onClick={() => toggleGroupOpen(group.key)}
                          aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {isOpen ? (
                            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                          )}
                          <span className="text-xs font-medium">
                            {t(`systools.uninstall.leftovers.groups.${group.key}`)}
                          </span>
                          <span className="text-muted-foreground truncate text-[11px]">
                            {t("systools.uninstall.leftovers.groupSummary", {
                              count: group.candidates.length,
                              bytes: formatBytes(group.bytes, language),
                            })}
                          </span>
                        </button>
                      </div>

                      {isOpen && (
                        <ul className="divide-y border-t">
                          {group.candidates.map((candidate) => (
                            <li
                              key={candidate.candidateId}
                              className="flex items-center gap-2 px-3 py-1.5"
                            >
                              <SelectionCheckbox
                                checked={selectedIds.has(candidate.candidateId)}
                                aria-label={candidate.path}
                                onCheckedChange={() => toggleCandidate(candidate.candidateId)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-xs">
                                    {candidate.applicationName}
                                  </span>
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 text-[10px] leading-4"
                                  >
                                    {t(`systools.uninstall.leftovers.sources.${candidate.source}`)}
                                  </Badge>
                                </div>
                                <p
                                  className="text-muted-foreground truncate text-[11px]"
                                  title={candidate.path}
                                >
                                  {candidate.path}
                                </p>
                              </div>
                              <span className="text-muted-foreground shrink-0 text-right text-[11px] tabular-nums">
                                {formatBytes(candidate.bytes, language)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-muted-foreground text-[11px]">
                  {t("systools.uninstall.leftovers.selected", {
                    count: selectedCandidates.length,
                    bytes: formatBytes(selectedBytes, language),
                  })}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {deleting && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void cancelDelete()}
                      disabled={cancellingDelete}
                    >
                      {cancellingDelete
                        ? t("systools.uninstall.leftovers.cancelling")
                        : t("systools.uninstall.leftovers.cancelDelete")}
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!selectedCandidates.length || deleting}
                    onClick={() => setConfirmOpen(true)}
                  >
                    {deleting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    {t("systools.uninstall.leftovers.deleteSelected", {
                      count: selectedCandidates.length,
                    })}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("systools.uninstall.leftovers.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("systools.uninstall.leftovers.confirmDescription", {
                count: selectedCandidates.length,
                bytes: formatBytes(selectedBytes, language),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              {t("systools.uninstall.actions.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void deleteSelected()}>
              {t("systools.uninstall.leftovers.confirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
