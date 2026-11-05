import { AlertTriangle, Loader2, XCircle } from "lucide-react";
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
import type {
  SystemSettingsChangePlan,
  SystemSettingTargetState,
  SystemSettingsChangeResult,
} from "@/lib/systools/system-settings";

type PlanDialogProps = {
  open: boolean;
  plan: SystemSettingsChangePlan | null;
  preparing: boolean;
  executing: boolean;
  result: SystemSettingsChangeResult | null;
  error: string | null;
  settingName: (settingId: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

function targetLabelKey(target: SystemSettingTargetState): string {
  return target === "optimized"
    ? "systools.optimize.status.optimized"
    : "systools.optimize.actions.restore";
}

function Notice({ children }: { children: string }) {
  return (
    <div className="border-border bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
      <AlertTriangle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Prepared plan review, execution state, and per-setting results. */
export function PlanDialog({
  open,
  plan,
  preparing,
  executing,
  result,
  error,
  settingName,
  onOpenChange,
  onConfirm,
}: PlanDialogProps) {
  const { t } = useAppTranslation();

  const failures = result ? result.items.filter((item) => item.status === "failed") : [];
  const planRequiresElevation = plan ? plan.items.some((item) => item.requiresElevation) : false;
  const title = result ? t("systools.optimize.result.title") : t("systools.optimize.plan.title");
  const description = result
    ? t("systools.optimize.result.changed", { count: result.changedCount })
    : plan
      ? t("systools.optimize.plan.description", { count: plan.items.length })
      : t("systools.common.loading");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (preparing || executing)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!preparing && !executing}
        className="flex max-h-[85vh] flex-col sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-0.5">
          {error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
            >
              {error}
            </div>
          )}

          {preparing && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <p className="text-muted-foreground text-xs">{t("systools.common.loading")}</p>
            </div>
          )}

          {!preparing && result && (
            <div className="space-y-3">
              <div className="bg-muted/40 grid grid-cols-2 gap-2 rounded-md p-3 text-xs">
                <p className="font-medium tabular-nums">
                  {t("systools.optimize.result.changed", { count: result.changedCount })}
                </p>
                <p
                  className={
                    result.failedCount > 0
                      ? "text-destructive font-medium tabular-nums"
                      : "font-medium tabular-nums"
                  }
                >
                  {t("systools.optimize.result.failed", { count: result.failedCount })}
                </p>
              </div>

              {result.requiresRestart && (
                <Notice>{t("systools.optimize.result.restartRequired")}</Notice>
              )}

              {result.recoveryAvailable && (
                <p className="text-muted-foreground text-[11px]">
                  {t("systools.optimize.result.recoveryAvailable")}
                </p>
              )}

              {failures.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {failures.map((item) => (
                    <li
                      key={item.settingId}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <XCircle className="text-destructive size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{settingName(item.settingId)}</span>
                      <span className="text-muted-foreground shrink-0 text-[11px]">
                        {item.failureReason
                          ? t(`systools.optimize.failureReasons.${item.failureReason}`)
                          : t("systools.errors.unknown")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!preparing && !result && plan && (
            <div className="space-y-3">
              {plan.requiresRestart && (
                <Notice>{t("systools.optimize.plan.requiresRestart")}</Notice>
              )}
              {planRequiresElevation && (
                <Notice>{t("systools.optimize.plan.requiresElevation")}</Notice>
              )}
              {plan.requiresConfirmation && (
                <Notice>{t("systools.optimize.riskDialog.description")}</Notice>
              )}

              {plan.items.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {t("systools.optimize.queue.empty")}
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {plan.items.map((item) => (
                    <li key={item.settingId} className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">
                          {settingName(item.settingId)}
                        </p>
                        <p className="text-muted-foreground text-[11px]">
                          {t(`systools.optimize.categories.${item.category}`)}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {t(targetLabelKey(item.target))}
                      </Badge>
                      {item.requiresRestart && (
                        <Badge variant="outline" className="text-[10px]">
                          {t("systools.optimize.badges.requiresRestart")}
                        </Badge>
                      )}
                      {item.requiresElevation && (
                        <Badge variant="outline" className="text-[10px]">
                          {t("systools.optimize.badges.requiresElevation")}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {plan.skippedItems.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-medium">
                    {t("systools.optimize.plan.skipped", { count: plan.skippedItems.length })}
                  </h3>
                  <ul className="text-muted-foreground space-y-1 text-[11px]">
                    {plan.skippedItems.map((item) => (
                      <li key={item.settingId} className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 truncate">
                          {settingName(item.settingId)}
                        </span>
                        <span className="shrink-0 text-right">
                          {t(`systools.optimize.skipReasons.${item.reason}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {executing && (
            <div className="flex items-center gap-2 text-xs">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-muted-foreground">{t("systools.common.loading")}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("systools.optimize.detail.close")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={preparing || executing}
              >
                {t("systools.optimize.plan.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={onConfirm}
                disabled={preparing || executing || !plan || plan.items.length === 0}
              >
                {executing ? <Loader2 className="size-4 animate-spin" /> : null}
                {executing ? t("systools.common.loading") : t("systools.optimize.plan.confirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
