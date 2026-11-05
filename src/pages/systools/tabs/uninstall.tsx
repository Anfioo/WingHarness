import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Loader2, RefreshCw, SearchX, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import {
  APPLICATION_ICON_BATCH_SIZE,
  UNINSTALL_EXECUTION_PROGRESS_EVENT,
  UNINSTALL_PROGRESS_EVENT,
  applicationBytes,
  applicationPublishers,
  applicationSourceLabelKey,
  defaultSelectedComponentIds,
  filterApplications,
  formatApplicationDate,
  sortApplications,
  systoolsApplicationIcons,
  systoolsErrorKey,
  systoolsUninstallCancelExecution,
  systoolsUninstallCancelScan,
  systoolsUninstallDescribeIdentity,
  systoolsUninstallExecuteBatch,
  systoolsUninstallOpenWindowsApps,
  systoolsUninstallPrepareBatch,
  systoolsUninstallScan,
  type ApplicationIdentityMetadata,
  type ApplicationScanProgress,
  type ApplicationSort,
  type ApplicationSortDirection,
  type ApplicationSourceFilter,
  type ApplicationUninstallBatchPreparation,
  type ApplicationUninstallBatchResult,
  type ApplicationUninstallCandidate,
  type ApplicationUninstallExecutionProgress,
  type ApplicationUninstallScanResult,
} from "@/lib/systools/applications";
import { formatBytes } from "@/lib/systools/format";
import { ApplicationIcon } from "../components/uninstall/application-icon";
import { ApplicationList } from "../components/uninstall/application-list";
import { LeftoversPanel } from "../components/uninstall/leftovers-panel";
import { PlanDialog } from "../components/uninstall/plan-dialog";
import { UninstallToolbar } from "../components/uninstall/uninstall-toolbar";

type Phase = "idle" | "scanning" | "ready" | "preparing" | "reviewing" | "executing" | "done";

const EMPTY_CANDIDATES: ApplicationUninstallCandidate[] = [];

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[128px_minmax(0,1fr)] gap-2 py-0.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-border bg-muted/40 mx-3 mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
      <AlertTriangle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function ScanningView({
  progress,
  stage,
  onCancel,
  cancelling,
}: {
  progress: ApplicationScanProgress | null;
  stage: string;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const { t } = useAppTranslation();
  const percent = progress?.percent ?? 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-sm font-medium">{t("systools.uninstall.scanning.title")}</span>
        <span className="text-muted-foreground truncate text-xs">{stage}</span>
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          {percent}%
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={cancelling}>
          {cancelling
            ? t("systools.uninstall.scanning.cancelling")
            : t("systools.uninstall.actions.cancel")}
        </Button>
      </div>
      <Progress
        value={percent}
        className={cn("h-0.5 rounded-none", percent === 0 && "animate-pulse")}
      />
      <div className="space-y-2 p-3" aria-busy="true">
        <p className="text-muted-foreground text-xs">
          {t("systools.uninstall.scanning.description")}
        </p>
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

/** Installed applications and the leftovers they leave behind. */
export function UninstallTab() {
  const { t, language } = useAppTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [scan, setScan] = useState<ApplicationUninstallScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ApplicationScanProgress | null>(null);
  const [cancellingScan, setCancellingScan] = useState(false);

  const [query, setQuery] = useState("");
  const [publisher, setPublisher] = useState("all");
  const [source, setSource] = useState<ApplicationSourceFilter>("all");
  const [sort, setSort] = useState<ApplicationSort>("name");
  const [direction, setDirection] = useState<ApplicationSortDirection>("asc");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  const [icons, setIcons] = useState<ReadonlyMap<string, string>>(() => new Map());
  const iconsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const iconVersion = useRef(0);

  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<ApplicationIdentityMetadata | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityFailed, setIdentityFailed] = useState(false);

  const [planOpen, setPlanOpen] = useState(false);
  const [preparation, setPreparation] = useState<ApplicationUninstallBatchPreparation | null>(null);
  const [previewResult, setPreviewResult] = useState<ApplicationUninstallBatchResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [executionProgress, setExecutionProgress] =
    useState<ApplicationUninstallExecutionProgress | null>(null);
  const [batchResult, setBatchResult] = useState<ApplicationUninstallBatchResult | null>(null);
  const [cancellingExecution, setCancellingExecution] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const scanVersion = useRef(0);
  const planVersion = useRef(0);
  const executionVersion = useRef(0);
  const executedRef = useRef(false);

  const candidates = scan?.candidates ?? EMPTY_CANDIDATES;
  const publishers = useMemo(() => applicationPublishers(candidates), [candidates]);

  const sortedCandidates = useMemo(() => {
    const filtered = filterApplications(candidates, {
      query,
      publisher: publisher === "all" ? null : publisher,
      source,
    });
    return sortApplications(filtered, sort, direction);
  }, [candidates, query, publisher, source, sort, direction]);

  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selectedIds.has(candidate.applicationId)),
    [candidates, selectedIds]
  );

  const selectedBytes = useMemo(
    () =>
      selectedCandidates.reduce((total, candidate) => {
        const defaults = candidate.components.filter((component) => component.defaultSelected);
        if (!defaults.length) return total + candidate.defaultSelectedBytes;
        return total + defaults.reduce((sum, component) => sum + component.bytes, 0);
      }, 0),
    [selectedCandidates]
  );

  const detailsCandidate = useMemo(
    () =>
      detailsId
        ? (candidates.find((candidate) => candidate.applicationId === detailsId) ?? null)
        : null,
    [candidates, detailsId]
  );

  const resetKey = `${query}\u0000${publisher}\u0000${source}\u0000${sort}\u0000${direction}`;

  // A scan running in the backend reports coarse progress even while the catalog
  // is still empty, so the skeleton can name the current stage.
  useEffect(() => {
    const unlisten = listen<ApplicationScanProgress>(UNINSTALL_PROGRESS_EVENT, (event) => {
      setScanProgress(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<ApplicationUninstallExecutionProgress>(
      UNINSTALL_EXECUTION_PROGRESS_EVENT,
      (event) => {
        setExecutionProgress(event.payload);
      }
    );
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Drop a publisher filter that no longer exists after a rescan.
  useEffect(() => {
    if (publisher !== "all" && !publishers.includes(publisher)) setPublisher("all");
  }, [publisher, publishers]);

  // Load icons for the visible rows only, in bounded batches, and keep them in
  // a cache so filtering or scrolling does not ask the shell again.
  const iconPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const candidate of sortedCandidates) {
      if (candidate.iconPath) paths.add(candidate.iconPath);
    }
    return [...paths];
  }, [sortedCandidates]);

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
          // Icons are decorative; a failed batch falls back to initials.
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [iconPaths]);

  // Identity metadata is only requested when the details sheet is open.
  useEffect(() => {
    const revision = scan?.catalogRevision;
    setIdentity(null);
    setIdentityFailed(false);
    if (!detailsCandidate || !revision) {
      setIdentityLoading(false);
      return;
    }
    let cancelled = false;
    setIdentityLoading(true);
    void systoolsUninstallDescribeIdentity(detailsCandidate.applicationId, revision)
      .then((value) => {
        if (cancelled) return;
        setIdentity(value.metadata);
      })
      .catch(() => {
        if (!cancelled) setIdentityFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIdentityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailsCandidate, scan?.catalogRevision]);

  function scanStageLabel(): string {
    switch (scanProgress?.stage) {
      case "checkingProcesses":
        return t("systools.uninstall.scanning.stages.checkingProcesses");
      case "validatingApplications":
        return t("systools.uninstall.scanning.stages.validatingApplications");
      default:
        return t("systools.uninstall.scanning.stages.discoveringApplications");
    }
  }

  async function runScan() {
    const version = ++scanVersion.current;
    setPhase("scanning");
    setScanError(null);
    setScanProgress(null);
    setSelectedIds(new Set());
    setDetailsId(null);
    try {
      const result = await systoolsUninstallScan();
      if (version !== scanVersion.current) return;
      setScan(result);
      setPhase("ready");
    } catch (error) {
      if (version !== scanVersion.current) return;
      setScanError(t(systoolsErrorKey(error)));
      setPhase((current) => (current === "scanning" ? "ready" : current));
    } finally {
      if (version === scanVersion.current) setCancellingScan(false);
    }
  }

  async function cancelScan() {
    if (cancellingScan) return;
    setCancellingScan(true);
    try {
      await systoolsUninstallCancelScan();
    } catch (error) {
      setScanError(t(systoolsErrorKey(error)));
      setCancellingScan(false);
    }
  }

  async function refreshCatalogQuietly() {
    const version = ++scanVersion.current;
    try {
      const result = await systoolsUninstallScan();
      if (version !== scanVersion.current) return;
      setScan(result);
      setSelectedIds(new Set());
    } catch {
      // Keep the current catalog; the user can scan again explicitly.
    }
  }

  function disabledReason(candidate: ApplicationUninstallCandidate): string | null {
    if (!scan) return null;
    if (!scan.executionSupported || !scan.catalogRevision) {
      return t("systools.uninstall.notices.executionUnsupported");
    }
    if (!scan.catalogActionable) return t("systools.uninstall.notices.catalogUnavailable");
    if (candidate.capability === "protectedApplication") {
      return t("systools.uninstall.notices.protectedApplication");
    }
    if (candidate.capability === "viewOnly") {
      return t("systools.uninstall.notices.viewOnly");
    }
    if (defaultSelectedComponentIds(candidate).length === 0) {
      return t("systools.uninstall.notices.noComponents");
    }
    return null;
  }

  function toggleSelection(applicationId: string) {
    const candidate = candidates.find((value) => value.applicationId === applicationId);
    if (!candidate || disabledReason(candidate)) return;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(applicationId)) next.delete(applicationId);
      else next.add(applicationId);
      return next;
    });
  }

  async function prepareSelected() {
    if (!scan?.catalogRevision || !scan.catalogActionable || !scan.executionSupported) return;
    const revision = scan.catalogRevision;
    const selections = selectedCandidates
      .map((candidate) => ({
        applicationId: candidate.applicationId,
        componentIds: defaultSelectedComponentIds(candidate),
      }))
      .filter((selection) => selection.componentIds.length > 0);
    if (!selections.length) return;

    const version = ++planVersion.current;
    setPlanOpen(true);
    setPreparation(null);
    setPreviewResult(null);
    setBatchResult(null);
    setExecutionProgress(null);
    setPlanError(null);
    setPhase("preparing");
    try {
      const prepared = await systoolsUninstallPrepareBatch(selections, revision);
      if (version !== planVersion.current) return;
      setPreparation(prepared);
      setPreviewResult(prepared.preview);
      setPhase("reviewing");
    } catch (error) {
      if (version !== planVersion.current) return;
      setPlanError(t(systoolsErrorKey(error)));
      setPhase("ready");
    }
  }

  async function previewPlan() {
    if (!preparation || previewing) return;
    setPreviewing(true);
    setPlanError(null);
    try {
      const result = await systoolsUninstallExecuteBatch(
        preparation.plan,
        true,
        t("systools.uninstall.plan.authorizationPrompt")
      );
      setPreviewResult(result);
    } catch (error) {
      setPlanError(t(systoolsErrorKey(error)));
    } finally {
      setPreviewing(false);
    }
  }

  async function executePlan() {
    if (!preparation || phase === "executing") return;
    const version = ++executionVersion.current;
    setPhase("executing");
    setPlanError(null);
    setBatchResult(null);
    setExecutionProgress(null);
    try {
      const result = await systoolsUninstallExecuteBatch(
        preparation.plan,
        false,
        t("systools.uninstall.plan.authorizationPrompt")
      );
      if (version !== executionVersion.current) return;
      setBatchResult(result);
      setPhase("done");
      executedRef.current = true;
      setSelectedIds(new Set());
    } catch (error) {
      if (version !== executionVersion.current) return;
      setPlanError(t(systoolsErrorKey(error)));
      setPhase("done");
    }
  }

  async function cancelExecution() {
    if (cancellingExecution) return;
    setCancellingExecution(true);
    try {
      await systoolsUninstallCancelExecution();
    } catch (error) {
      setPlanError(t(systoolsErrorKey(error)));
      setCancellingExecution(false);
    }
  }

  function closePlan() {
    const shouldRefresh = executedRef.current;
    executedRef.current = false;
    setPlanOpen(false);
    setPreparation(null);
    setPreviewResult(null);
    setBatchResult(null);
    setExecutionProgress(null);
    setPlanError(null);
    setPreviewing(false);
    setCancellingExecution(false);
    setPhase("ready");
    if (shouldRefresh) void refreshCatalogQuietly();
  }

  function handlePlanOpenChange(open: boolean) {
    if (open) {
      setPlanOpen(true);
      return;
    }
    if (phase === "executing" || phase === "preparing") return;
    closePlan();
  }

  async function openWindowsApps() {
    try {
      await systoolsUninstallOpenWindowsApps();
    } catch (error) {
      setScanError(t(systoolsErrorKey(error)));
    }
  }

  const showCatalog = scan !== null;
  const scanRunning = phase === "scanning";
  const catalogBytes = useMemo(
    () => candidates.reduce((total, candidate) => total + applicationBytes(candidate), 0),
    [candidates]
  );

  if (phase === "scanning" && !scan) {
    return (
      <ScanningView
        progress={scanProgress}
        stage={scanStageLabel()}
        onCancel={() => void cancelScan()}
        cancelling={cancellingScan}
      />
    );
  }

  if (!showCatalog) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
          <Trash2 className="size-6" />
        </div>
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t("systools.uninstall.empty.title")}</h2>
          <p className="text-muted-foreground max-w-md text-sm">
            {t("systools.uninstall.empty.description")}
          </p>
        </div>
        {scanError && (
          <p role="alert" className="text-destructive text-xs">
            {scanError}
          </p>
        )}
        <Button size="sm" onClick={() => void runScan()}>
          {scanError ? <RefreshCw className="size-4" /> : <Trash2 className="size-4" />}
          {t("systools.uninstall.actions.scan")}
        </Button>
      </div>
    );
  }

  const canUninstall =
    scan.catalogActionable && scan.executionSupported && Boolean(scan.catalogRevision);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <UninstallToolbar
          query={query}
          onQueryChange={setQuery}
          publisher={publisher}
          onPublisherChange={setPublisher}
          publishers={publishers}
          source={source}
          onSourceChange={setSource}
          sort={sort}
          onSortChange={setSort}
          direction={direction}
          onDirectionToggle={() => setDirection((current) => (current === "asc" ? "desc" : "asc"))}
          scanning={scanRunning}
          hasScanned
          busy={phase === "preparing" || phase === "executing"}
          onScan={() => void runScan()}
          onOpenWindowsApps={() => void openWindowsApps()}
        />

        {scanRunning && (
          <div className="bg-muted/40 mx-3 mt-2 overflow-hidden rounded-md text-xs">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">
                {t("systools.uninstall.scanning.title")} · {scanStageLabel()}
              </span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {scanProgress?.percent ?? 0}%
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={cancellingScan}
                onClick={() => void cancelScan()}
              >
                {cancellingScan
                  ? t("systools.uninstall.scanning.cancelling")
                  : t("systools.uninstall.actions.cancel")}
              </Button>
            </div>
            <Progress value={scanProgress?.percent ?? 0} className="h-0.5 rounded-none" />
          </div>
        )}

        {scanError && (
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

        {!scan.catalogActionable && (
          <Notice title={t("systools.uninstall.notices.catalogUnavailableTitle")}>
            {t("systools.uninstall.notices.catalogUnavailable")}
          </Notice>
        )}
        {!canUninstall && scan.catalogActionable && (
          <Notice title={t("systools.uninstall.notices.executionUnsupportedTitle")}>
            {t("systools.uninstall.notices.executionUnsupported")}
          </Notice>
        )}
        {!scan.inventoryComplete && (
          <Notice title={t("systools.uninstall.notices.inventoryIncompleteTitle")}>
            {t("systools.uninstall.notices.inventoryIncomplete")}
          </Notice>
        )}

        <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
          <span>{t("systools.uninstall.summary.total", { count: candidates.length })}</span>
          <span>{t("systools.uninstall.summary.ready", { count: scan.readyCount })}</span>
          <span>{t("systools.uninstall.summary.blocked", { count: scan.blockedCount })}</span>
          <span className="ml-auto">
            {t("systools.uninstall.summary.estimatedSize", {
              bytes: formatBytes(catalogBytes, language),
            })}
          </span>
        </div>

        {sortedCandidates.length > 0 ? (
          <ApplicationList
            applications={sortedCandidates}
            selectedIds={selectedIds}
            icons={icons}
            resetKey={resetKey}
            disabledReason={disabledReason}
            onToggle={toggleSelection}
            onOpen={setDetailsId}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <SearchX className="text-muted-foreground size-8" />
            <p className="text-sm font-medium">{t("systools.uninstall.emptyFiltered.title")}</p>
            <p className="text-muted-foreground max-w-sm text-xs">
              {t("systools.uninstall.emptyFiltered.description")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setPublisher("all");
                setSource("all");
              }}
            >
              {t("systools.uninstall.actions.clearFilters")}
            </Button>
          </div>
        )}

        <LeftoversPanel />

        {canUninstall && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
            <span className="text-xs">
              {t("systools.uninstall.summary.selected", { count: selectedCandidates.length })}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("systools.uninstall.summary.selectedSize", {
                bytes: formatBytes(selectedBytes, language),
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-1"
              disabled={!selectedCandidates.length}
              onClick={() => setSelectedIds(new Set())}
            >
              {t("systools.uninstall.actions.clearSelection")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="ml-auto"
              disabled={!selectedCandidates.length || phase === "preparing"}
              onClick={() => void prepareSelected()}
            >
              {phase === "preparing" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {t("systools.uninstall.actions.uninstall")}
            </Button>
          </div>
        )}
      </div>

      <Sheet
        open={detailsCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {detailsCandidate && (
            <>
              <SheetHeader>
                <div className="flex items-start gap-3 pr-6">
                  <ApplicationIcon
                    name={detailsCandidate.name}
                    src={
                      detailsCandidate.iconPath ? icons.get(detailsCandidate.iconPath) : undefined
                    }
                    className="size-10"
                  />
                  <div className="min-w-0">
                    <SheetTitle className="truncate">{detailsCandidate.name}</SheetTitle>
                    <SheetDescription className="truncate">
                      {detailsCandidate.publisher ?? detailsCandidate.primaryIdentifier}
                      {detailsCandidate.version
                        ? ` · ${t("systools.uninstall.columns.version", {
                            version: detailsCandidate.version,
                          })}`
                        : ""}
                    </SheetDescription>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">
                    {t(`systools.uninstall.capabilities.${detailsCandidate.capability}`)}
                  </Badge>
                  <Badge variant="outline">
                    {t(`systools.uninstall.recordStates.${detailsCandidate.recordState}`)}
                  </Badge>
                  {detailsCandidate.installerKind && (
                    <Badge variant="outline">
                      {t(`systools.uninstall.installerKinds.${detailsCandidate.installerKind}`)}
                    </Badge>
                  )}
                </div>
              </SheetHeader>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
                <section>
                  <h3 className="mb-1 text-xs font-medium">
                    {t("systools.uninstall.details.identity")}
                  </h3>
                  {identityLoading ? (
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-4 w-1/2" />
                    </div>
                  ) : identity ? (
                    <dl>
                      {identity.productName && (
                        <DetailRow
                          label={t("systools.uninstall.details.productName")}
                          value={identity.productName}
                        />
                      )}
                      {identity.fileDescription && (
                        <DetailRow
                          label={t("systools.uninstall.details.fileDescription")}
                          value={identity.fileDescription}
                        />
                      )}
                      {identity.companyName && (
                        <DetailRow
                          label={t("systools.uninstall.details.companyName")}
                          value={identity.companyName}
                        />
                      )}
                      {identity.packageIdentity && (
                        <DetailRow
                          label={t("systools.uninstall.details.packageIdentity")}
                          value={identity.packageIdentity}
                        />
                      )}
                    </dl>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      {identityFailed
                        ? t("systools.uninstall.details.identityFailed")
                        : t("systools.uninstall.details.identityUnavailable")}
                    </p>
                  )}
                </section>

                {detailsCandidate.uninstallDiagnostic && (
                  <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {t(`systools.uninstall.diagnostics.${detailsCandidate.uninstallDiagnostic}`)}
                    </span>
                  </div>
                )}

                <section>
                  <h3 className="mb-1 text-xs font-medium">
                    {t("systools.uninstall.details.catalog")}
                  </h3>
                  <dl>
                    <DetailRow
                      label={t("systools.uninstall.details.primaryIdentifier")}
                      value={detailsCandidate.primaryIdentifier}
                    />
                    <DetailRow
                      label={t("systools.uninstall.details.systemKind")}
                      value={t(`systools.uninstall.systemKinds.${detailsCandidate.systemKind}`)}
                    />
                    {detailsCandidate.executionMode && (
                      <DetailRow
                        label={t("systools.uninstall.details.executionMode")}
                        value={t(
                          `systools.uninstall.executionModes.${detailsCandidate.executionMode}`
                        )}
                      />
                    )}
                    {detailsCandidate.applicationPath && (
                      <DetailRow
                        label={t("systools.uninstall.details.applicationPath")}
                        value={
                          <span className="break-all" title={detailsCandidate.applicationPath}>
                            {detailsCandidate.applicationPath}
                          </span>
                        }
                      />
                    )}
                    <DetailRow
                      label={t("systools.uninstall.details.installed")}
                      value={
                        detailsCandidate.dates.installed
                          ? formatApplicationDate(
                              detailsCandidate.dates.installed.timestampMs,
                              language
                            )
                          : t("systools.uninstall.columns.unknownDate")
                      }
                    />
                    <DetailRow
                      label={t("systools.uninstall.details.lastUsed")}
                      value={
                        detailsCandidate.dates.lastUsed
                          ? formatApplicationDate(
                              detailsCandidate.dates.lastUsed.timestampMs,
                              language
                            )
                          : t("systools.uninstall.columns.unknownDate")
                      }
                    />
                    <DetailRow
                      label={t("systools.uninstall.details.estimatedSize")}
                      value={formatBytes(detailsCandidate.estimatedBytes, language)}
                    />
                    <DetailRow
                      label={t("systools.uninstall.details.totalSize")}
                      value={formatBytes(detailsCandidate.totalBytes, language)}
                    />
                    <DetailRow
                      label={t("systools.uninstall.details.sources")}
                      value={
                        <span className="flex flex-wrap gap-1">
                          {detailsCandidate.sourceIdentities.map((identityEntry) => (
                            <Badge
                              key={`${identityEntry.source}:${identityEntry.identifier}`}
                              variant="outline"
                              className="text-[10px]"
                            >
                              {t(
                                `systools.uninstall.sources.${applicationSourceLabelKey(
                                  identityEntry.source
                                )}`
                              )}
                            </Badge>
                          ))}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <section>
                  <h3 className="mb-1 text-xs font-medium">
                    {t("systools.uninstall.details.components")}
                  </h3>
                  {detailsCandidate.components.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t("systools.uninstall.details.componentsEmpty")}
                    </p>
                  ) : (
                    <ul className="divide-y rounded-md border">
                      {detailsCandidate.components.map((component) => (
                        <li key={component.componentId} className="px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate">
                              {t(`systools.uninstall.componentKinds.${component.kind}`)}
                            </span>
                            <span className="text-muted-foreground shrink-0 tabular-nums">
                              {formatBytes(component.bytes, language)}
                            </span>
                          </div>
                          <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                            <span>{t(`systools.uninstall.componentRisks.${component.risk}`)}</span>
                            <span>
                              ·{" "}
                              {t("systools.uninstall.details.fileCount", {
                                count: component.fileCount,
                              })}
                            </span>
                            {component.path && (
                              <span className="truncate" title={component.path}>
                                · {component.path}
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="mb-1 text-xs font-medium">
                    {t("systools.uninstall.details.runningProcesses")}
                  </h3>
                  {detailsCandidate.runningProcesses.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t("systools.uninstall.details.runningProcessesEmpty")}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {detailsCandidate.runningProcesses.map((processName) => (
                        <Badge key={processName} variant="outline" className="text-[10px]">
                          {processName}
                        </Badge>
                      ))}
                    </div>
                  )}
                </section>

                {detailsCandidate.possibleRelatedPaths.length > 0 && (
                  <section>
                    <h3 className="mb-1 text-xs font-medium">
                      {t("systools.uninstall.details.possibleRelatedPaths")}
                    </h3>
                    <p className="text-muted-foreground mb-1 text-[11px]">
                      {t("systools.uninstall.details.possibleRelatedPathsDescription")}
                    </p>
                    <ul className="space-y-0.5">
                      {detailsCandidate.possibleRelatedPaths.map((path) => (
                        <li
                          key={path}
                          className="text-muted-foreground truncate text-[11px]"
                          title={path}
                        >
                          {path}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              <SheetFooter>
                <Button variant="outline" onClick={() => setDetailsId(null)}>
                  {t("systools.uninstall.actions.close")}
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <PlanDialog
        open={planOpen}
        plan={preparation?.plan ?? null}
        preview={previewResult}
        candidates={candidates}
        selectedCandidates={selectedCandidates}
        preparing={phase === "preparing"}
        previewing={previewing}
        executing={phase === "executing"}
        cancelling={cancellingExecution}
        progress={executionProgress}
        result={batchResult}
        error={planError}
        onOpenChange={handlePlanOpenChange}
        onPreview={() => void previewPlan()}
        onExecute={() => void executePlan()}
        onCancelExecution={() => void cancelExecution()}
      />
    </TooltipProvider>
  );
}
