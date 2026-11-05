import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { analysisFailureReasonKey, type AnalysisDeleteBatchResult } from "@/lib/systools/storage";
import { formatBytes, formatCount } from "@/lib/systools/format";

type DeleteResultDialogProps = {
  open: boolean;
  result: AnalysisDeleteBatchResult | null;
  onOpenChange: (open: boolean) => void;
};

/** Outcome summary for a batch deletion, including per-path failures. */
export function DeleteResultDialog({ open, result, onOpenChange }: DeleteResultDialogProps) {
  const { t, language } = useAppTranslation();
  if (!result) return null;

  const reasonLabel = (reason: string | null): string => {
    const key = analysisFailureReasonKey(reason);
    if (key) return t(key);
    return reason?.trim() ? reason : t("systools.analysis.deleteResult.unknownReason");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("systools.analysis.deleteResult.title")}</DialogTitle>
          <DialogDescription>{t("systools.analysis.deleteResult.description")}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div className="bg-muted/40 rounded-md border px-2 py-1.5">
            <dt className="text-muted-foreground flex items-center gap-1 text-[10px]">
              <CheckCircle2 className="size-3" aria-hidden="true" />
              {t("systools.analysis.deleteResult.removed")}
            </dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {formatCount(result.removedPaths.length, language)}
            </dd>
          </div>
          <div className="bg-muted/40 rounded-md border px-2 py-1.5">
            <dt className="text-muted-foreground flex items-center gap-1 text-[10px]">
              <AlertTriangle className="size-3" aria-hidden="true" />
              {t("systools.analysis.deleteResult.failed")}
            </dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {formatCount(result.failed.length, language)}
            </dd>
          </div>
          <div className="bg-muted/40 rounded-md border px-2 py-1.5">
            <dt className="text-muted-foreground flex items-center gap-1 text-[10px]">
              <MinusCircle className="size-3" aria-hidden="true" />
              {t("systools.analysis.deleteResult.notAttempted")}
            </dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {formatCount(result.notAttemptedPaths.length, language)}
            </dd>
          </div>
        </dl>

        <p className="text-muted-foreground text-[11px] tabular-nums">
          {t("systools.analysis.deleteResult.released", {
            size: formatBytes(result.releasedBytes, language),
          })}
        </p>

        {result.failed.length > 0 ? (
          <div className="max-h-32 overflow-y-auto rounded-md border px-3 py-1.5 text-[11px]">
            {result.failed.map((failure) => (
              <p key={failure.path} className="py-0.5">
                <span className="block truncate" title={failure.path}>
                  {failure.path}
                </span>
                <span className="text-destructive">{reasonLabel(failure.reason)}</span>
              </p>
            ))}
          </div>
        ) : null}

        {result.notAttemptedPaths.length > 0 ? (
          <p className="text-muted-foreground text-[11px]">
            {t("systools.analysis.deleteResult.notAttemptedHint", {
              count: result.notAttemptedPaths.length,
            })}
          </p>
        ) : null}

        {result.requiresRescan ? (
          <p className="text-muted-foreground flex items-start gap-2 text-[11px]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("systools.analysis.deleteResult.rescanHint")}
          </p>
        ) : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("systools.analysis.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
