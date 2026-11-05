import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";
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
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  type ApplicationUninstallBatchPlan,
  type ApplicationUninstallBatchResult,
  type ApplicationUninstallCandidate,
  type ApplicationUninstallExecutionProgress,
  type ApplicationUninstallPlan,
  type ApplicationUninstallResult,
} from "@/lib/systools/applications";
import { formatBytes } from "@/lib/systools/format";
import { cn } from "@/lib/utils";

type PlanDialogProps = {
  open: boolean;
  plan: ApplicationUninstallBatchPlan | null;
  preview: ApplicationUninstallBatchResult | null;
  candidates: ApplicationUninstallCandidate[];
  selectedCandidates: ApplicationUninstallCandidate[];
  preparing: boolean;
  previewing: boolean;
  executing: boolean;
  cancelling: boolean;
  progress: ApplicationUninstallExecutionProgress | null;
  result: ApplicationUninstallBatchResult | null;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onPreview: () => void;
  onExecute: () => void;
  onCancelExecution: () => void;
};

type ExecutionState = "pending" | "active" | "completed" | "cancelled" | "failed";

type ExecutionRow = {
  applicationId: string;
  name: string;
  state: ExecutionState;
  detail: string;
};

function planItemBytes(plan: ApplicationUninstallPlan): number {
  return plan.items.reduce((total, item) => total + item.expectedBytes, 0);
}

function resultState(result: ApplicationUninstallResult): {
  state: ExecutionState;
  reason: string | null;
} {
  const failed = result.actions.find((action) => action.status === "failed");
  if (result.failedItemCount > 0) {
    return { state: "failed", reason: failed?.reason ?? null };
  }
  const allCancelled =
    result.actions.length > 0 && result.actions.every((action) => action.status === "cancelled");
  if (allCancelled || (result.affectedItemCount === 0 && result.actions.length === 0)) {
    return { state: "cancelled", reason: failed?.reason ?? null };
  }
  return { state: "completed", reason: null };
}

function StateIcon({ state }: { state: ExecutionState }) {
  switch (state) {
    case "completed":
      return <CheckCircle2 className="text-primary size-4" />;
    case "cancelled":
      return <MinusCircle className="text-muted-foreground size-4" />;
    case "failed":
      return <XCircle className="text-destructive size-4" />;
    case "active":
      return <Loader2 className="text-primary size-4 animate-spin" />;
    case "pending":
      return <Circle className="text-muted-foreground/50 size-4" />;
  }
}

/** Review, preview, execution progress, and per-application results. */
export function PlanDialog({
  open,
  plan,
  preview,
  candidates,
  selectedCandidates,
  preparing,
  previewing,
  executing,
  cancelling,
  progress,
  result,
  error,
  onOpenChange,
  onPreview,
  onExecute,
  onCancelExecution,
}: PlanDialogProps) {
  const { t, language } = useAppTranslation();

  const candidateById = useMemo(() => {
    const map = new Map<string, ApplicationUninstallCandidate>();
    for (const candidate of candidates) map.set(candidate.applicationId, candidate);
    return map;
  }, [candidates]);

  const processes = useMemo(() => {
    const names = new Set<string>();
    for (const candidate of selectedCandidates) {
      for (const name of candidate.runningProcesses) names.add(name);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [selectedCandidates]);

  const riskSummary = useMemo(() => {
    let nativeInstaller = false;
    let userData = false;
    let relatedPaths = 0;
    let incompleteData = false;
    const plans = plan?.plans ?? [];
    for (const applicationPlan of plans) {
      const candidate = candidateById.get(applicationPlan.applicationId);
      if (!candidate) continue;
      if (!candidate.associatedDataComplete) incompleteData = true;
      relatedPaths += candidate.possibleRelatedPaths.length;
      for (const item of applicationPlan.items) {
        if (item.kind === "nativeInstaller") nativeInstaller = true;
        const component = candidate.components.find(
          (value) => value.componentId === item.componentId
        );
        if (component?.risk === "userData") userData = true;
      }
    }
    return { nativeInstaller, userData, relatedPaths, incompleteData };
  }, [plan, candidateById]);

  const leftoverBytes = useMemo(() => {
    const plans = new Map(
      (plan?.plans ?? []).map((applicationPlan) => [
        applicationPlan.applicationId,
        new Set(applicationPlan.items.map((item) => item.componentId)),
      ])
    );
    return selectedCandidates.reduce((total, candidate) => {
      const selected = plans.get(candidate.applicationId);
      if (!selected) return total;
      return (
        total +
        candidate.components
          .filter((component) => !selected.has(component.componentId))
          .reduce((sum, component) => sum + component.bytes, 0)
      );
    }, 0);
  }, [plan, selectedCandidates]);

  const executionRows = useMemo<ExecutionRow[]>(() => {
    if (result) {
      return result.results.map((item) => {
        const { state, reason } = resultState(item);
        return {
          applicationId: item.applicationId,
          name:
            item.applicationName ??
            candidateById.get(item.applicationId)?.name ??
            t("systools.uninstall.plan.unknownApplication"),
          state,
          detail:
            state === "failed"
              ? reason
                ? t(`systools.uninstall.reasons.${reason}`)
                : t("systools.uninstall.plan.resultFailed")
              : state === "cancelled"
                ? t("systools.uninstall.plan.resultCancelled")
                : t("systools.uninstall.plan.resultCompleted"),
        };
      });
    }
    const completed = new Map(
      (progress?.completedApplications ?? []).map((item) => [item.applicationId, item])
    );
    return (plan?.plans ?? []).map((applicationPlan) => {
      const candidate = candidateById.get(applicationPlan.applicationId);
      const finished = completed.get(applicationPlan.applicationId);
      const active =
        !finished &&
        progress?.stage === "uninstalling" &&
        progress.currentApplicationId === applicationPlan.applicationId;
      const state: ExecutionState = finished?.status ?? (active ? "active" : "pending");
      const detail =
        state === "failed"
          ? t("systools.uninstall.plan.resultFailed")
          : state === "cancelled"
            ? t("systools.uninstall.plan.resultCancelled")
            : state === "completed"
              ? t("systools.uninstall.plan.resultCompleted")
              : state === "active"
                ? t("systools.uninstall.plan.executingStageItem")
                : t("systools.uninstall.plan.pending");
      return {
        applicationId: applicationPlan.applicationId,
        name: candidate?.name ?? t("systools.uninstall.plan.unknownApplication"),
        state,
        detail,
      };
    });
  }, [result, progress, plan, candidateById, t]);

  const totalApplications = plan?.plans.length ?? 0;
  const completedApplications = result
    ? result.results.length
    : (progress?.completedApplicationCount ?? 0);
  const executionPercent =
    totalApplications > 0
      ? Math.min(100, Math.round((completedApplications / totalApplications) * 100))
      : 0;
  const activeApplicationName = executionRows.find((row) => row.state === "active")?.name ?? null;

  const title = executing
    ? activeApplicationName
      ? t("systools.uninstall.plan.executingTitle", { name: activeApplicationName })
      : t("systools.uninstall.plan.executingTitleGeneric")
    : result
      ? t("systools.uninstall.plan.doneTitle")
      : t("systools.uninstall.plan.title", { count: totalApplications });

  const description = executing
    ? t("systools.uninstall.plan.executingDescription")
    : result
      ? t("systools.uninstall.plan.doneDescription")
      : preparing
        ? t("systools.uninstall.plan.preparingDescription")
        : t("systools.uninstall.plan.description");

  const installerLabel = (candidate: ApplicationUninstallCandidate) =>
    candidate.installerKind
      ? t(`systools.uninstall.installerKinds.${candidate.installerKind}`)
      : t("systools.uninstall.installerKinds.unknown");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (executing || cancelling || preparing)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!executing && !cancelling}
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-0.5">
          {error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive mb-3 rounded-md border px-3 py-2 text-xs"
            >
              {error}
            </div>
          )}

          {preparing && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <p className="text-muted-foreground text-xs">
                {t("systools.uninstall.plan.preparing")}
              </p>
            </div>
          )}

          {!preparing && (executing || result) && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">
                    {t("systools.uninstall.plan.progress", {
                      completed: completedApplications,
                      total: totalApplications,
                    })}
                  </span>
                  <span className="text-muted-foreground">
                    {executing
                      ? t(`systools.uninstall.plan.stages.${progress?.stage ?? "validating"}`)
                      : t("systools.uninstall.plan.doneStage")}
                  </span>
                </div>
                <Progress value={result ? 100 : executionPercent} />
              </div>

              {result && (
                <div className="bg-muted/40 grid grid-cols-2 gap-2 rounded-md p-3 text-xs sm:grid-cols-3">
                  <div>
                    <p className="text-muted-foreground">{t("systools.uninstall.plan.released")}</p>
                    <p className="font-medium tabular-nums">
                      {formatBytes(result.releasedBytes, language)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">
                      {t("systools.uninstall.plan.failedApplications")}
                    </p>
                    <p className="font-medium tabular-nums">{result.failedApplicationCount}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">
                      {t("systools.uninstall.plan.skippedApplications")}
                    </p>
                    <p className="font-medium tabular-nums">
                      {Math.max(
                        0,
                        result.selectedApplicationCount -
                          result.affectedApplicationCount -
                          result.failedApplicationCount
                      )}
                    </p>
                  </div>
                </div>
              )}

              {result?.restartRequired && (
                <div className="border-border bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                  <AlertTriangle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                  <span>{t("systools.uninstall.plan.restartRequired")}</span>
                </div>
              )}

              <ul className="divide-y rounded-md border">
                {executionRows.map((row) => (
                  <li key={row.applicationId} className="flex items-center gap-3 px-3 py-2">
                    <StateIcon state={row.state} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{row.name}</p>
                      <p className="text-muted-foreground truncate text-[11px]">{row.detail}</p>
                    </div>
                    <span className="text-muted-foreground text-[11px]">
                      {t(`systools.uninstall.plan.states.${row.state}`)}
                    </span>
                  </li>
                ))}
              </ul>

              {executing && (
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onCancelExecution}
                    disabled={cancelling}
                  >
                    {cancelling
                      ? t("systools.uninstall.plan.cancelling")
                      : t("systools.uninstall.actions.cancelExecution")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {!preparing && !executing && !result && (
            <div className="space-y-4">
              <div className="bg-muted/40 grid grid-cols-2 gap-2 rounded-md p-3 text-xs sm:grid-cols-3">
                <div>
                  <p className="text-muted-foreground">
                    {t("systools.uninstall.plan.applications")}
                  </p>
                  <p className="font-medium tabular-nums">{totalApplications}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">
                    {t("systools.uninstall.plan.expectedBytes")}
                  </p>
                  <p className="font-medium tabular-nums">
                    {formatBytes(plan?.expectedBytes ?? 0, language)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">
                    {t("systools.uninstall.plan.estimatedLeftover")}
                  </p>
                  <p className="font-medium tabular-nums">{formatBytes(leftoverBytes, language)}</p>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-medium">
                  {t("systools.uninstall.plan.perApplication")}
                </h3>
                <div className="space-y-2">
                  {(plan?.plans ?? []).map((applicationPlan) => {
                    const candidate = candidateById.get(applicationPlan.applicationId);
                    return (
                      <div key={applicationPlan.planId} className="rounded-md border">
                        <div className="flex items-start justify-between gap-3 border-b px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">
                              {candidate?.name ?? t("systools.uninstall.plan.unknownApplication")}
                            </p>
                            {candidate && (
                              <p className="text-muted-foreground truncate text-[11px]">
                                {installerLabel(candidate)}
                                {candidate.executionMode
                                  ? ` · ${t(`systools.uninstall.executionModes.${candidate.executionMode}`)}`
                                  : ""}
                              </p>
                            )}
                          </div>
                          <span className="shrink-0 text-xs tabular-nums">
                            {formatBytes(
                              applicationPlan.expectedBytes || planItemBytes(applicationPlan),
                              language
                            )}
                          </span>
                        </div>
                        <ul className="px-3 py-1.5">
                          {applicationPlan.items.map((item) => (
                            <li
                              key={item.componentId}
                              className="flex items-center justify-between gap-2 py-0.5 text-[11px]"
                            >
                              <span className="truncate">
                                {t(`systools.uninstall.componentKinds.${item.kind}`)}
                              </span>
                              <span className="text-muted-foreground shrink-0 tabular-nums">
                                {formatBytes(item.expectedBytes, language)} ·{" "}
                                {t("systools.uninstall.plan.files", {
                                  count: item.expectedFileCount,
                                })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <h3 className="text-xs font-medium">{t("systools.uninstall.plan.processes")}</h3>
                {processes.length > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {processes.map((name) => (
                        <Badge key={name} variant="outline" className="text-[11px]">
                          {name}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-muted-foreground text-[11px]">
                      {t("systools.uninstall.plan.processIdsUnavailable")}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground text-[11px]">
                    {t("systools.uninstall.plan.processesNone")}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <h3 className="text-xs font-medium">{t("systools.uninstall.plan.risks")}</h3>
                <ul className="text-muted-foreground space-y-1 text-[11px]">
                  {riskSummary.nativeInstaller && (
                    <li className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {t("systools.uninstall.plan.riskNativeInstaller")}
                    </li>
                  )}
                  {riskSummary.userData && (
                    <li className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {t("systools.uninstall.plan.riskUserData")}
                    </li>
                  )}
                  {riskSummary.incompleteData && (
                    <li className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {t("systools.uninstall.plan.riskIncompleteData")}
                    </li>
                  )}
                  {riskSummary.relatedPaths > 0 && (
                    <li className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {t("systools.uninstall.plan.riskRelatedPaths", {
                        count: riskSummary.relatedPaths,
                      })}
                    </li>
                  )}
                  {!riskSummary.nativeInstaller &&
                    !riskSummary.userData &&
                    !riskSummary.incompleteData &&
                    riskSummary.relatedPaths === 0 && (
                      <li>{t("systools.uninstall.plan.risksNone")}</li>
                    )}
                </ul>
              </div>

              {preview && (
                <div
                  className={cn(
                    "rounded-md border px-3 py-2 text-[11px]",
                    preview.failedItemCount > 0
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-border bg-muted/40"
                  )}
                >
                  <p className="font-medium">
                    {t("systools.uninstall.plan.previewSummary", {
                      applications: preview.previewedApplicationCount,
                      items: preview.previewedItemCount,
                    })}
                  </p>
                  <p>
                    {t("systools.uninstall.plan.previewBytes", {
                      bytes: formatBytes(preview.previewedBytes, language),
                    })}
                  </p>
                  {preview.failedItemCount > 0 && (
                    <p>
                      {t("systools.uninstall.plan.previewFailed", {
                        count: preview.failedItemCount,
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {result || (!executing && !preparing) ? (
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {result
                ? t("systools.uninstall.actions.done")
                : t("systools.uninstall.actions.cancel")}
            </Button>
          ) : null}
          {!executing && !result && !preparing && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onPreview}
                disabled={previewing || !plan}
              >
                {previewing ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("systools.uninstall.actions.preview")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={onExecute}
                disabled={previewing || !plan}
              >
                {t("systools.uninstall.actions.uninstall")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
