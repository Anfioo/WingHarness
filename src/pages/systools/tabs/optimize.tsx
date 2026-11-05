import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { isCancellationError, parseSystoolsError } from "@/lib/systools/applications";
import {
  buildRestoreSelection,
  cancelSystemSettingsScan,
  executeSystemSettingsChange,
  groupByCategory,
  isSettingSelectable,
  prepareSystemSettingsChange,
  scanSystemSettings,
  SYSTEM_SETTING_CATEGORIES,
  targetForFlip,
  type SystemSettingCategory,
  type SystemSettingsChangePlan,
  type SystemSettingsChangeSelection,
  type SystemSettingItem,
  type SystemSettingTargetState,
  type SystemSettingsCatalog,
  type SystemSettingsChangeResult,
} from "@/lib/systools/system-settings";
import { ApplyBar } from "../components/optimize/apply-bar";
import { CategorySection } from "../components/optimize/category-section";
import { HighRiskDialog } from "../components/optimize/confirm-dialog";
import { OptimizeToolbar } from "../components/optimize/optimize-toolbar";
import { PlanDialog } from "../components/optimize/plan-dialog";
import { RecoveryDialog } from "../components/optimize/recovery-dialog";
import { settingFallbackName, settingNameKey } from "../components/optimize/setting-labels";

type PlanMode = "apply" | "recovery";

/** Map a command rejection to the shared systools error copy. */
function errorMessageKey(error: unknown): string {
  const parsed = parseSystoolsError(error);
  if (!parsed) return "systools.errors.unknown";
  if (isCancellationError(parsed)) return "systools.errors.operationCancelled";
  return `systools.errors.${parsed.code}`;
}

function ScanSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

/** Windows system settings that can be tuned from one place. */
export function OptimizeTab() {
  const { t } = useAppTranslation();

  const [catalog, setCatalog] = useState<SystemSettingsCatalog | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [pending, setPending] = useState<Map<string, SystemSettingTargetState>>(() => new Map());
  const [collapsed, setCollapsed] = useState<ReadonlySet<SystemSettingCategory>>(() => new Set());

  const [riskOpen, setRiskOpen] = useState(false);
  const [riskItemNames, setRiskItemNames] = useState<string[]>([]);

  const [planOpen, setPlanOpen] = useState(false);
  const [planMode, setPlanMode] = useState<PlanMode>("apply");
  const [plan, setPlan] = useState<SystemSettingsChangePlan | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<SystemSettingsChangeResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const scanVersion = useRef(0);
  const startedRef = useRef(false);

  async function runScan() {
    const version = ++scanVersion.current;
    setScanning(true);
    setScanError(null);
    try {
      const next = await scanSystemSettings();
      if (version !== scanVersion.current) return;
      setCatalog(next);
      setPending(new Map());
    } catch (error) {
      if (version !== scanVersion.current) return;
      const parsed = parseSystoolsError(error);
      if (parsed && isCancellationError(parsed)) {
        setScanError(null);
        toast.info(t("systools.optimize.toast.scanCancelled"));
      } else {
        setScanError(t(errorMessageKey(error)));
        toast.error(t("systools.optimize.toast.scanFailed"));
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
      await cancelSystemSettingsScan();
    } catch (error) {
      setScanError(t(errorMessageKey(error)));
      setCancellingScan(false);
    }
  }

  // Used after a change when the backend omits the refreshed catalog.
  async function refreshCatalogQuietly() {
    const version = ++scanVersion.current;
    try {
      const next = await scanSystemSettings();
      if (version !== scanVersion.current) return;
      setCatalog(next);
    } catch {
      // Keep the current catalog; the user can scan again explicitly.
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runScan();
    // A ref guard makes this a single intentional mount scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resolveSettingName(settingId: string): string {
    return t(settingNameKey(settingId), { defaultValue: settingFallbackName(settingId) });
  }

  function toggleSetting(item: SystemSettingItem) {
    if (!isSettingSelectable(item)) return;
    const base: SystemSettingTargetState = item.status === "optimized" ? "optimized" : "default";
    const flipTarget = targetForFlip(item);
    setPending((previous) => {
      const next = new Map(previous);
      const current = previous.get(item.settingId) ?? base;
      const target = current === flipTarget ? base : flipTarget;
      if (target === base) next.delete(item.settingId);
      else next.set(item.settingId, target);
      return next;
    });
  }

  function optimizeAll() {
    if (!catalog) return;
    setPending((previous) => {
      const next = new Map(previous);
      for (const item of catalog.items) {
        if (item.selectionKind !== "oneClick" || !item.selectedByDefault) continue;
        if (!isSettingSelectable(item) || item.status !== "recommended") continue;
        next.set(item.settingId, "optimized");
      }
      return next;
    });
  }

  function toggleCategory(category: SystemSettingCategory) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  async function prepareSelected(mode: PlanMode, selection?: SystemSettingsChangeSelection) {
    if (!catalog) return;
    const payload = selection ?? {
      scanId: catalog.scanId,
      items: [...pending.entries()].map(([settingId, target]) => ({ settingId, target })),
    };
    if (payload.items.length === 0) return;

    setPlanMode(mode);
    setPlanOpen(true);
    setPreparing(true);
    setPlan(null);
    setResult(null);
    setPlanError(null);

    try {
      const prepared = await prepareSystemSettingsChange(payload);
      setPlan(prepared);
      if (prepared.items.length === 0 && prepared.skippedItems.length > 0) {
        toast.info(t("systools.optimize.plan.skipped", { count: prepared.skippedItems.length }));
      }
    } catch (error) {
      setPlanError(t(errorMessageKey(error)));
      toast.error(
        t(
          mode === "recovery"
            ? "systools.optimize.toast.rollbackFailed"
            : "systools.optimize.toast.planFailed"
        )
      );
    } finally {
      setPreparing(false);
    }
  }

  async function executePlan() {
    if (!plan || preparing || executing) return;
    setExecuting(true);
    setPlanError(null);
    try {
      const next = await executeSystemSettingsChange(plan.planId);
      setResult(next);
      setPending(new Map());
      if (next.catalog) setCatalog(next.catalog);
      else void refreshCatalogQuietly();

      const cancelledByUser = next.items.some((item) => item.failureReason === "userCancelled");
      if (cancelledByUser) {
        toast.info(t("systools.optimize.failureReasons.userCancelled"));
      } else if (next.failedCount > 0) {
        toast.warning(t("systools.optimize.result.failed", { count: next.failedCount }));
      } else {
        toast.success(
          t(
            planMode === "recovery"
              ? "systools.optimize.toast.rollbackApplied"
              : "systools.optimize.toast.applied"
          )
        );
      }
    } catch (error) {
      setPlanError(t(errorMessageKey(error)));
      toast.error(
        t(
          planMode === "recovery"
            ? "systools.optimize.toast.rollbackFailed"
            : "systools.optimize.toast.applyFailed"
        )
      );
    } finally {
      setExecuting(false);
    }
  }

  function requestApply() {
    if (!catalog || pending.size === 0) return;
    const highRisk = catalog.items.filter(
      (item) => pending.has(item.settingId) && item.riskLevel === "high"
    );
    if (highRisk.length > 0) {
      setRiskItemNames(highRisk.map((item) => resolveSettingName(item.settingId)));
      setRiskOpen(true);
      return;
    }
    void prepareSelected("apply");
  }

  function handleRiskOpenChange(open: boolean) {
    setRiskOpen(open);
    if (!open) setRiskItemNames([]);
  }

  function confirmHighRisk() {
    setRiskOpen(false);
    setRiskItemNames([]);
    void prepareSelected("apply");
  }

  function handlePlanOpenChange(open: boolean) {
    if (open) {
      setPlanOpen(true);
      return;
    }
    if (preparing || executing) return;
    setPlanOpen(false);
    setPlan(null);
    setResult(null);
    setPlanError(null);
  }

  async function confirmRecovery() {
    if (!catalog) return;
    const selection = buildRestoreSelection(catalog);
    if (selection.items.length === 0) {
      setRecoveryOpen(false);
      toast.info(t("systools.optimize.rollback.unavailable"));
      return;
    }
    setRecoveryOpen(false);
    setRestoring(true);
    try {
      await prepareSelected("recovery", selection);
    } finally {
      setRestoring(false);
    }
  }

  const busy = scanning || preparing || executing || restoring;

  const groups = useMemo(() => {
    const present = new Map(
      groupByCategory(catalog?.items ?? []).map((group) => [group.category, group.items] as const)
    );
    return SYSTEM_SETTING_CATEGORIES.map((category) => ({
      category,
      items: present.get(category) ?? [],
    }));
  }, [catalog]);

  const bulkEligibleCount = useMemo(
    () =>
      catalog
        ? catalog.items.filter(
            (item) =>
              item.selectionKind === "oneClick" &&
              item.selectedByDefault &&
              item.status === "recommended"
          ).length
        : 0,
    [catalog]
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <OptimizeToolbar
          scanning={scanning}
          cancelling={cancellingScan}
          busy={busy}
          hasScanned={catalog !== null}
          recoveryAvailable={catalog?.recoveryAvailable === true}
          restoring={restoring}
          onScan={() => void runScan()}
          onCancelScan={() => void cancelScan()}
          onRestore={() => setRecoveryOpen(true)}
        />

        {scanning && catalog && (
          <div className="bg-muted/40 mx-3 mt-2 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">{t("systools.optimize.scanning")}</span>
            <Button
              variant="ghost"
              size="xs"
              disabled={cancellingScan}
              onClick={() => void cancelScan()}
            >
              {t("systools.optimize.cancelScan")}
            </Button>
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

        {catalog && catalog.items.length > 0 && (
          <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
            <span>
              {t("systools.optimize.summary.total", { count: catalog.summary.itemCount })}
            </span>
            <span className="flex items-center gap-1">
              <span>{t("systools.optimize.summary.recommended")}</span>
              <span className="text-foreground tabular-nums">
                {catalog.summary.recommendedCount}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span>{t("systools.optimize.summary.optimized")}</span>
              <span className="text-foreground tabular-nums">{catalog.summary.optimizedCount}</span>
            </span>
            <span className="flex items-center gap-1">
              <span>{t("systools.optimize.summary.unavailable")}</span>
              <span className="text-foreground tabular-nums">
                {catalog.summary.unavailableCount}
              </span>
            </span>
            {pending.size > 0 && (
              <span className="text-foreground ml-auto">
                {t("systools.optimize.summary.selected", { count: pending.size })}
              </span>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {!catalog ? (
            scanning ? (
              <ScanSkeleton />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
                  <SlidersHorizontal className="size-6" />
                </div>
                <div className="space-y-1">
                  <h2 className="text-sm font-medium">{t("systools.optimize.title")}</h2>
                  <p className="text-muted-foreground max-w-md text-sm">
                    {scanError ? t("systools.optimize.error") : t("systools.optimize.empty")}
                  </p>
                </div>
                <Button size="sm" onClick={() => void runScan()}>
                  <RefreshCw className="size-4" />
                  {t("systools.optimize.scan")}
                </Button>
              </div>
            )
          ) : catalog.items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <SlidersHorizontal className="text-muted-foreground size-8" />
              <p className="text-sm">{t("systools.optimize.empty")}</p>
              <Button variant="outline" size="sm" onClick={() => void runScan()}>
                <RefreshCw className="size-4" />
                {t("systools.optimize.rescan")}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {groups.map((group) => (
                <CategorySection
                  key={group.category}
                  category={group.category}
                  items={group.items}
                  collapsed={collapsed.has(group.category)}
                  busy={busy}
                  pending={pending}
                  onToggleCollapse={toggleCategory}
                  onToggleSetting={toggleSetting}
                />
              ))}
            </div>
          )}
        </div>

        {catalog && catalog.items.length > 0 && (
          <ApplyBar
            count={pending.size}
            bulkEligibleCount={bulkEligibleCount}
            busy={busy}
            onOptimizeAll={optimizeAll}
            onClear={() => setPending(new Map())}
            onApply={requestApply}
          />
        )}
      </div>

      <HighRiskDialog
        open={riskOpen}
        itemNames={riskItemNames}
        onOpenChange={handleRiskOpenChange}
        onConfirm={confirmHighRisk}
      />

      <PlanDialog
        open={planOpen}
        plan={plan}
        preparing={preparing}
        executing={executing}
        result={result}
        error={planError}
        settingName={resolveSettingName}
        onOpenChange={handlePlanOpenChange}
        onConfirm={() => void executePlan()}
      />

      <RecoveryDialog
        open={recoveryOpen}
        busy={restoring}
        onOpenChange={setRecoveryOpen}
        onConfirm={() => void confirmRecovery()}
      />
    </TooltipProvider>
  );
}
