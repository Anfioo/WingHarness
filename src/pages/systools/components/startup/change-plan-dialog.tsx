import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  MinusCircle,
  ShieldAlert,
  XCircle,
} from "lucide-react";
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
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  sourceFilterOf,
  type StartupChangeItemResult,
  type StartupChangePlan,
  type StartupChangeWarning,
} from "@/lib/systools/startup";
import { cn } from "@/lib/utils";
import {
  configuredStateLabelKey,
  desiredStateLabelKey,
  startupFilterLabelKey,
} from "./startup-labels";

type DialogPhase = "preparing" | "reviewing" | "executing" | "done";

type ChangePlanDialogProps = {
  open: boolean;
  plans: StartupChangePlan[];
  phase: DialogPhase;
  /** Per-item results collected while applying the plans. */
  results: StartupChangeItemResult[];
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

function resultIcon(status: StartupChangeItemResult["status"]) {
  if (status === "changed") return <CheckCircle2 className="text-primary size-4" />;
  if (status === "failed") return <XCircle className="text-destructive size-4" />;
  return <MinusCircle className="text-muted-foreground size-4" />;
}

/** Confirmation, busy state, and the result summary for startup changes. */
export function ChangePlanDialog({
  open,
  plans,
  phase,
  results,
  error,
  onOpenChange,
  onConfirm,
}: ChangePlanDialogProps) {
  const { t } = useAppTranslation();

  const planItems = plans.flatMap((plan) => plan.items);
  const skippedItems = plans.flatMap((plan) => plan.skippedItems);
  const planItemsById = new Map(planItems.map((item) => [item.itemId, item]));
  const warnings = [...new Set<StartupChangeWarning>(planItems.flatMap((item) => item.warnings))];
  const requiresElevation = planItems.some((item) => item.requiresElevation);
  const requiresConfirmation = plans.some((plan) => plan.requiresConfirmation);
  const changedCount = results.filter((item) => item.status === "changed").length;
  const failedCount = results.filter((item) => item.status === "failed").length;

  const title =
    phase === "done" ? t("systools.startup.result.title") : t("systools.startup.plan.title");
  const description =
    phase === "done"
      ? `${t("systools.startup.result.changed", { count: changedCount })} · ${t(
          "systools.startup.result.failed",
          { count: failedCount }
        )}`
      : phase === "preparing" || phase === "executing"
        ? t("systools.common.loading")
        : plans.length > 0
          ? plans
              .map((plan) =>
                t("systools.startup.plan.description", {
                  count: plan.items.length,
                  state: t(desiredStateLabelKey(plan.desiredState)),
                })
              )
              .join(" ")
          : t("systools.startup.queue.empty");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (phase === "preparing" || phase === "executing")) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={phase === "reviewing" || phase === "done"}
        className="flex max-h-[85vh] flex-col sm:max-w-xl"
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

          {phase === "preparing" && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <p className="text-muted-foreground text-xs">{t("systools.common.loading")}</p>
            </div>
          )}

          {phase === "executing" && (
            <div className="flex items-center gap-2 py-4 text-xs" aria-busy="true">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("systools.common.loading")}</span>
            </div>
          )}

          {phase === "reviewing" && plans.length > 0 && (
            <div className="space-y-3">
              <ul className="divide-y rounded-md border">
                {planItems.map((item) => (
                  <li key={item.itemId} className="flex items-center gap-2 px-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={item.displayName}>
                        {item.displayName}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="text-[10px] leading-4">
                          {t(startupFilterLabelKey(sourceFilterOf(item.sourceKind)))}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] leading-4">
                          {t(`systools.startup.scopes.${item.scope}`)}
                        </Badge>
                        {item.requiresElevation && (
                          <Badge variant="secondary" className="text-[10px] leading-4">
                            {t("systools.startup.control.elevationRequired")}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className="text-muted-foreground shrink-0 text-[10px] leading-4"
                    >
                      {t(configuredStateLabelKey(item.previousState))}
                    </Badge>
                    <ArrowRight className="text-muted-foreground size-3 shrink-0" />
                    <Badge
                      variant={item.desiredState === "enabled" ? "secondary" : "outline"}
                      className="shrink-0 text-[10px] leading-4"
                    >
                      {t(desiredStateLabelKey(item.desiredState))}
                    </Badge>
                  </li>
                ))}
              </ul>

              {warnings.length > 0 && (
                <ul className="text-muted-foreground space-y-1 text-[11px]">
                  {warnings.map((warning) => (
                    <li key={warning} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {t(`systools.startup.plan.warnings.${warning}`)}
                    </li>
                  ))}
                </ul>
              )}

              {skippedItems.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-xs font-medium">
                    {t("systools.startup.plan.skipped", { count: skippedItems.length })}
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {skippedItems.map((item) => (
                      <li
                        key={item.itemId}
                        className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
                      >
                        <span className="min-w-0 truncate" title={item.displayName}>
                          {item.displayName}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-[11px]">
                          {t(`systools.startup.skipReasons.${item.reason}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(requiresElevation || requiresConfirmation) && (
                <p className="border-border bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px]">
                  <ShieldAlert className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                  {t("systools.startup.plan.requiresElevation")}
                </p>
              )}
            </div>
          )}

          {phase === "done" && (
            <div className="space-y-3">
              <div className="bg-muted/40 grid grid-cols-2 gap-2 rounded-md p-3 text-xs">
                <p className="font-medium tabular-nums">
                  {t("systools.startup.result.changed", { count: changedCount })}
                </p>
                <p className="font-medium tabular-nums">
                  {t("systools.startup.result.failed", { count: failedCount })}
                </p>
              </div>

              <ul className="divide-y rounded-md border">
                {results.map((item) => {
                  const planItem = planItemsById.get(item.itemId);
                  const detail =
                    item.status === "failed"
                      ? item.failureReason
                        ? t(`systools.startup.failureReasons.${item.failureReason}`)
                        : t("systools.startup.failureReasons.platformFailure")
                      : t(configuredStateLabelKey(item.configuredState));
                  return (
                    <li key={item.itemId} className="flex items-center gap-2 px-3 py-1.5">
                      {resultIcon(item.status)}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">
                          {planItem?.displayName ?? t("systools.startup.detail.title")}
                        </p>
                        <p
                          className={cn(
                            "truncate text-[11px]",
                            item.status === "failed" ? "text-destructive" : "text-muted-foreground"
                          )}
                        >
                          {detail}
                        </p>
                      </div>
                      {item.verified && (
                        <Badge variant="outline" className="shrink-0 text-[10px] leading-4">
                          {t("systools.startup.result.verified")}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {phase === "reviewing" && plans.length === 0 && !error && (
            <p className="text-muted-foreground py-4 text-xs">
              {t("systools.startup.queue.empty")}
            </p>
          )}
        </div>

        <DialogFooter>
          {phase === "reviewing" && (
            <>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t("systools.startup.plan.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={onConfirm}
                disabled={planItems.length === 0 || error !== null}
              >
                {t("systools.startup.plan.confirm")}
              </Button>
            </>
          )}
          {phase === "executing" && (
            <Button size="sm" disabled>
              <Loader2 className="size-4 animate-spin" />
              {t("systools.startup.plan.confirm")}
            </Button>
          )}
          {phase === "done" && (
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("systools.startup.detail.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
