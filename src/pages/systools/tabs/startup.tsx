import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Play, RefreshCw, SearchX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  APPLICATION_ICON_BATCH_SIZE,
  isCancellationError,
  parseSystoolsError,
  systoolsApplicationIcons,
} from "@/lib/systools/applications";
import {
  STARTUP_SCAN_PROGRESS_EVENT,
  STARTUP_SCAN_SOURCE_TOTAL,
  cancelStartupChange,
  cancelStartupScan,
  executeStartupChange,
  matchesSourceFilter,
  nextDesiredState,
  prepareStartupChange,
  scanStartupItems,
  sourceFilterOf,
  type StartupArtifact,
  type StartupCatalog,
  type StartupChangeItemResult,
  type StartupChangePlan,
  type StartupDesiredState,
  type StartupScanProgress,
  type StartupSourceFilter,
} from "@/lib/systools/startup";
import { ChangePlanDialog } from "../components/startup/change-plan-dialog";
import { ChangeQueue, type StartupQueueEntry } from "../components/startup/change-queue";
import { CoverageNotice } from "../components/startup/coverage-notice";
import { StartupList } from "../components/startup/startup-list";
import { StartupToolbar } from "../components/startup/startup-toolbar";
import {
  startupScanSourceLabelKey,
  startupToggleBlockedKey,
} from "../components/startup/startup-labels";
import { ScanProgressStrip, ScanProgressView } from "../components/common/scan-progress";

type Phase = "scanning" | "ready" | "preparing" | "reviewing" | "executing" | "done";

type DialogPhase = "preparing" | "reviewing" | "executing" | "done";

const EMPTY_ARTIFACTS: StartupArtifact[] = [];

/** i18n key for a command rejection; cancellations read as user cancellations. */
function startupErrorKey(error: unknown): string {
  const parsed = parseSystoolsError(error);
  if (!parsed) return "systools.errors.unknown";
  switch (parsed.code) {
    case "invalidInput":
      return "systools.errors.invalidInput";
    case "permissionDenied":
      return "systools.errors.permissionDenied";
    case "notImplemented":
      return "systools.errors.notImplemented";
    case "operationCancelled":
      return "systools.startup.toast.cancelledByUser";
    default:
      return "systools.errors.operationFailed";
  }
}

function isCancelledError(error: unknown): boolean {
  const parsed = parseSystoolsError(error);
  return parsed !== null && isCancellationError(parsed);
}

/** Sources scan in parallel, so completion order is not the start order. */
function startupScanNumbers(progress: StartupScanProgress | null) {
  const completed = progress?.completedSources ?? 0;
  const total = progress?.totalSources ?? STARTUP_SCAN_SOURCE_TOTAL;
  return {
    completed,
    total,
    itemsFound: progress?.itemsFound ?? 0,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
  };
}

/** Startup entries: what Windows launches when the user signs in. */
export function StartupTab() {
  const { t } = useAppTranslation();

  const [phase, setPhase] = useState<Phase>("scanning");
  const [catalog, setCatalog] = useState<StartupCatalog | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [scanProgress, setScanProgress] = useState<StartupScanProgress | null>(null);
  const [scanElapsedSeconds, setScanElapsedSeconds] = useState(0);
  const [filter, setFilter] = useState<StartupSourceFilter>("all");
  const [query, setQuery] = useState("");
  const [queue, setQueue] = useState<ReadonlyMap<string, StartupDesiredState>>(() => new Map());
  const [plans, setPlans] = useState<StartupChangePlan[]>([]);
  const [planOpen, setPlanOpen] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [results, setResults] = useState<StartupChangeItemResult[]>([]);
  const [coverageDismissed, setCoverageDismissed] = useState(false);
  const [icons, setIcons] = useState<ReadonlyMap<string, string>>(() => new Map());

  const iconsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const iconVersion = useRef(0);
  const scanVersion = useRef(0);
  const planVersion = useRef(0);
  const executionVersion = useRef(0);
  const executedRef = useRef(false);
  const startedRef = useRef(false);

  const artifacts = catalog?.artifacts ?? EMPTY_ARTIFACTS;

  const scanning = phase === "scanning";

  // The native scan reports one event per finished source, so the bar advances
  // even though the command promise only settles once every source is done.
  useEffect(() => {
    const unlisten = listen<StartupScanProgress>(STARTUP_SCAN_PROGRESS_EVENT, (event) => {
      setScanProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // The last progress event can be seconds old while a slow source finishes, so
  // the clock ticks locally instead of trusting the reported elapsed value.
  useEffect(() => {
    if (!scanning) return;
    const startedAt = Date.now();
    setScanElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setScanElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [scanning]);

  const counts = useMemo(() => {
    const next: Record<StartupSourceFilter, number> = {
      all: 0,
      registry: 0,
      folder: 0,
      service: 0,
      task: 0,
      app: 0,
      advanced: 0,
    };
    for (const artifact of artifacts) {
      next.all += 1;
      next[sourceFilterOf(artifact.sourceKind)] += 1;
    }
    return next;
  }, [artifacts]);

  const visibleArtifacts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return artifacts.filter((artifact) => {
      if (!matchesSourceFilter(artifact, filter)) return false;
      if (!needle) return true;
      return [
        artifact.displayName,
        artifact.ownerName,
        artifact.publisher,
        artifact.summary,
        artifact.target.path,
        artifact.target.executableName,
      ].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(needle));
    });
  }, [artifacts, filter, query]);

  const artifactsById = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.itemId, artifact])),
    [artifacts]
  );

  const queueEntries = useMemo<StartupQueueEntry[]>(() => {
    const entries: StartupQueueEntry[] = [];
    for (const [itemId, desiredState] of queue) {
      const artifact = artifactsById.get(itemId);
      if (!artifact) continue;
      entries.push({
        itemId,
        displayName: artifact.displayName,
        previousState: artifact.configuredState,
        desiredState,
      });
    }
    return entries;
  }, [queue, artifactsById]);

  const resetKey = `${filter}\u0000${query}`;
  const busy = phase === "preparing" || phase === "executing";
  const dialogPhase: DialogPhase =
    phase === "preparing"
      ? "preparing"
      : phase === "executing"
        ? "executing"
        : phase === "done"
          ? "done"
          : "reviewing";

  // Resolve row and group icons once per catalog; failures fall back to initials.
  const iconPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.iconPath) paths.add(artifact.iconPath);
    }
    for (const group of catalog?.groups ?? []) {
      if (group.iconPath) paths.add(group.iconPath);
    }
    return [...paths];
  }, [artifacts, catalog]);

  useEffect(() => {
    const missing = iconPaths.filter((path) => !iconsRef.current.has(path));
    if (!missing.length) return;
    const version = ++iconVersion.current;
    let cancelled = false;

    void (async () => {
      for (let start = 0; start < missing.length; start += APPLICATION_ICON_BATCH_SIZE) {
        if (cancelled || version !== iconVersion.current) return;
        const batch = missing.slice(start, start + APPLICATION_ICON_BATCH_SIZE);
        try {
          const loaded = await systoolsApplicationIcons(batch);
          if (cancelled || version !== iconVersion.current) return;
          setIcons((previous) => {
            const next = new Map(previous);
            for (const icon of loaded) next.set(icon.path, icon.dataUrl);
            iconsRef.current = next;
            return next;
          });
        } catch {
          // Icons are decorative; the initials badge stays in place.
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [iconPaths]);

  async function runScan() {
    const version = ++scanVersion.current;
    setPhase("scanning");
    setScanError(null);
    setScanProgress(null);
    setCancellingScan(false);
    try {
      const next = await scanStartupItems();
      if (version !== scanVersion.current) return;
      setCatalog(next);
      setQueue(new Map());
      setPlans([]);
      setResults([]);
      setPlanError(null);
      setCoverageDismissed(false);
      setPhase("ready");
    } catch (error) {
      if (version !== scanVersion.current) return;
      if (isCancelledError(error)) {
        toast.info(t("systools.startup.toast.scanCancelled"));
      } else {
        const message = t(startupErrorKey(error));
        setScanError(message);
        toast.error(t("systools.startup.toast.scanFailed"), { description: message });
      }
      setPhase("ready");
    } finally {
      if (version === scanVersion.current) setCancellingScan(false);
    }
  }

  async function cancelScan() {
    if (cancellingScan) return;
    setCancellingScan(true);
    try {
      await cancelStartupScan();
    } catch (error) {
      setCancellingScan(false);
      toast.error(t("systools.startup.toast.scanFailed"), {
        description: t(startupErrorKey(error)),
      });
    }
  }

  async function refreshQuietly() {
    const version = ++scanVersion.current;
    try {
      const next = await scanStartupItems();
      if (version !== scanVersion.current) return;
      setCatalog(next);
      setCoverageDismissed(false);
    } catch {
      // Keep the current catalog; the user can scan again explicitly.
    }
  }

  useEffect(() => {
    // A ref guard keeps React 19's development double-invoke from scanning twice.
    if (startedRef.current) return;
    startedRef.current = true;
    void runScan();
    // A ref guard makes this a single intentional mount scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function blockedReason(artifact: StartupArtifact): string | null {
    const key = startupToggleBlockedKey(artifact);
    return key ? t(key) : null;
  }

  function toggleItem(artifact: StartupArtifact) {
    if (startupToggleBlockedKey(artifact)) return;
    setQueue((previous) => {
      const next = new Map(previous);
      if (next.has(artifact.itemId)) next.delete(artifact.itemId);
      else next.set(artifact.itemId, nextDesiredState(artifact));
      return next;
    });
  }

  function removeQueued(itemId: string) {
    setQueue((previous) => {
      if (!previous.has(itemId)) return previous;
      const next = new Map(previous);
      next.delete(itemId);
      return next;
    });
  }

  async function reviewChanges() {
    if (!catalog || queue.size === 0 || busy || phase === "scanning") return;

    const grouped = new Map<StartupDesiredState, string[]>();
    for (const [itemId, desiredState] of queue) {
      const itemIds = grouped.get(desiredState) ?? [];
      itemIds.push(itemId);
      grouped.set(desiredState, itemIds);
    }

    const version = ++planVersion.current;
    setPlanOpen(true);
    setPlans([]);
    setResults([]);
    setPlanError(null);
    executedRef.current = false;
    setPhase("preparing");

    try {
      const prepared: StartupChangePlan[] = [];
      for (const [desiredState, itemIds] of grouped) {
        const plan = await prepareStartupChange({
          scanId: catalog.scanId,
          itemIds,
          desiredState,
        });
        if (version !== planVersion.current) return;
        prepared.push(plan);
      }
      setPlans(prepared);
      setPhase("reviewing");
    } catch (error) {
      if (version !== planVersion.current) return;
      const message = t(startupErrorKey(error));
      setPlanError(message);
      setPhase("ready");
      toast.error(t("systools.startup.toast.planFailed"), { description: message });
      void cancelStartupChange().catch(() => undefined);
    }
  }

  async function executePlans() {
    if (phase !== "reviewing" || plans.length === 0) return;

    const version = ++executionVersion.current;
    const authorizationPrompt = `${t("app.title")} — ${t("systools.startup.title")}`;
    setPhase("executing");
    setPlanError(null);
    setResults([]);

    const collected: StartupChangeItemResult[] = [];
    let latestCatalog: StartupCatalog | null = null;
    let thrown: unknown = null;

    for (const plan of plans) {
      try {
        const result = await executeStartupChange(plan.planId, authorizationPrompt);
        if (version !== executionVersion.current) return;
        collected.push(...result.items);
        if (result.catalog) latestCatalog = result.catalog;
      } catch (error) {
        if (version !== executionVersion.current) return;
        thrown = error;
        break;
      }
    }
    if (version !== executionVersion.current) return;

    executedRef.current = thrown === null;
    setResults(collected);
    setQueue(new Map());
    if (latestCatalog) {
      setCatalog(latestCatalog);
      setCoverageDismissed(false);
    }
    setPhase("done");

    const failedCount = collected.filter((item) => item.status === "failed").length;
    const cancelled = collected.some((item) => item.failureReason === "userCancelled");

    if (thrown !== null) {
      if (isCancelledError(thrown)) {
        setPlanError(t("systools.startup.toast.cancelledByUser"));
        toast.error(t("systools.startup.toast.cancelledByUser"));
      } else {
        const message = t(startupErrorKey(thrown));
        setPlanError(message);
        toast.error(t("systools.startup.toast.applyFailed"), { description: message });
      }
    } else if (cancelled) {
      setPlanError(t("systools.startup.failureReasons.userCancelled"));
      toast.error(t("systools.startup.toast.cancelledByUser"));
    } else if (failedCount > 0) {
      toast.error(t("systools.startup.toast.applyFailed"));
    } else {
      toast.success(t("systools.startup.toast.applied"));
    }

    if (!latestCatalog) void refreshQuietly();
  }

  function closePlan() {
    if (!executedRef.current && plans.length > 0) {
      void cancelStartupChange().catch(() => undefined);
    }
    executedRef.current = false;
    planVersion.current += 1;
    setPlanOpen(false);
    setPlans([]);
    setResults([]);
    setPlanError(null);
    setPhase("ready");
  }

  function handlePlanOpenChange(open: boolean) {
    if (open) return;
    if (phase === "preparing" || phase === "executing") return;
    closePlan();
  }

  const scanNumbers = startupScanNumbers(scanProgress);
  const scanSourceKey = scanProgress ? startupScanSourceLabelKey(scanProgress.sourceId) : null;
  const scanStage = scanProgress
    ? t("systools.startup.scanProgress.source", {
        source: scanSourceKey ? t(scanSourceKey) : scanProgress.sourceId,
      })
    : t("systools.startup.scanProgress.waiting");
  const scanStats = [
    {
      label: t("systools.startup.scanProgress.labels.sources"),
      value: `${scanNumbers.completed} / ${scanNumbers.total}`,
    },
    {
      label: t("systools.startup.scanProgress.labels.items"),
      value: scanNumbers.itemsFound.toLocaleString(),
    },
    {
      label: t("systools.startup.scanProgress.labels.elapsed"),
      value: t("systools.startup.scanProgress.seconds", { seconds: scanElapsedSeconds }),
    },
  ];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <StartupToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          query={query}
          onQueryChange={setQuery}
          scanning={scanning}
          cancellingScan={cancellingScan}
          hasCatalog={catalog !== null}
          busy={busy}
          onScan={() => void runScan()}
          onCancelScan={() => void cancelScan()}
        />

        {scanError && catalog && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mx-3 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{scanError}</span>
            <Button variant="ghost" size="xs" onClick={() => void runScan()}>
              {t("systools.common.retry")}
            </Button>
          </div>
        )}

        {catalog && scanning && (
          <ScanProgressStrip
            title={t("systools.startup.scanProgress.title")}
            currentPath={scanStage}
            summary={`${scanNumbers.completed} / ${scanNumbers.total} · ${scanNumbers.itemsFound.toLocaleString()} · ${t(
              "systools.startup.scanProgress.seconds",
              { seconds: scanElapsedSeconds }
            )}`}
            percent={scanNumbers.percent}
            determinate={scanNumbers.completed > 0}
          />
        )}

        {!catalog && scanning && (
          <ScanProgressView
            title={t("systools.startup.scanProgress.title")}
            label={t("systools.startup.scanProgress.currentStage")}
            currentPath={scanStage}
            percent={scanNumbers.percent}
            determinate={scanNumbers.completed > 0}
            cancelling={cancellingScan}
            cancelLabel={t("systools.startup.cancelScan")}
            cancellingLabel={t("systools.startup.scanProgress.cancelling")}
            description={t("systools.startup.scanProgress.description")}
            stats={scanStats}
            onCancel={() => void cancelScan()}
          />
        )}

        {!catalog && !scanning && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
              <Play className="size-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-medium">
                {scanError ? t("systools.startup.error") : t("systools.startup.title")}
              </h2>
              <p className="text-muted-foreground max-w-md text-sm">
                {scanError ?? t("systools.startup.empty")}
              </p>
            </div>
            <Button size="sm" onClick={() => void runScan()}>
              <RefreshCw className="size-4" />
              {t("systools.startup.scan")}
            </Button>
          </div>
        )}

        {catalog && (
          <>
            {!coverageDismissed && (
              <CoverageNotice catalog={catalog} onDismiss={() => setCoverageDismissed(true)} />
            )}

            <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
              <span className="text-foreground font-medium">
                {t("systools.startup.summary.items", {
                  count: catalog.summary.itemCount,
                })}
              </span>
              <span>
                {t("systools.startup.summary.enabled")}{" "}
                <span className="tabular-nums">{catalog.summary.enabledCount}</span>
              </span>
              <span>
                {t("systools.startup.summary.disabled")}{" "}
                <span className="tabular-nums">{catalog.summary.disabledCount}</span>
              </span>
              <span>
                {t("systools.startup.summary.unknown")}{" "}
                <span className="tabular-nums">{catalog.summary.unknownStateCount}</span>
              </span>
              <span>
                {t("systools.startup.summary.elevation")}{" "}
                <span className="tabular-nums">{catalog.summary.elevationRequiredCount}</span>
              </span>
              <span>
                {t("systools.startup.summary.system")}{" "}
                <span className="tabular-nums">{catalog.summary.systemItemCount}</span>
              </span>
            </div>

            {visibleArtifacts.length > 0 ? (
              <StartupList
                catalog={catalog}
                artifacts={visibleArtifacts}
                icons={icons}
                queue={queue}
                resetKey={resetKey}
                blockedReason={blockedReason}
                onToggle={toggleItem}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <SearchX className="text-muted-foreground size-8" />
                <p className="text-sm font-medium">{t("systools.startup.emptyFiltered")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  {t("systools.startup.actions.clearFilters")}
                </Button>
              </div>
            )}
          </>
        )}

        <ChangeQueue
          entries={queueEntries}
          busy={busy || scanning}
          onRemove={removeQueued}
          onClear={() => setQueue(new Map())}
          onReview={() => void reviewChanges()}
        />
      </div>

      <ChangePlanDialog
        open={planOpen}
        plans={plans}
        phase={dialogPhase}
        results={results}
        error={planError}
        onOpenChange={handlePlanOpenChange}
        onConfirm={() => void executePlans()}
      />
    </TooltipProvider>
  );
}
