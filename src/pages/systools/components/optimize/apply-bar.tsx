import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

type ApplyBarProps = {
  count: number;
  bulkEligibleCount: number;
  busy: boolean;
  onOptimizeAll: () => void;
  onClear: () => void;
  onApply: () => void;
};

/** Pending-change summary and the review action. */
export function ApplyBar({
  count,
  bulkEligibleCount,
  busy,
  onOptimizeAll,
  onClear,
  onApply,
}: ApplyBarProps) {
  const { t } = useAppTranslation();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
      <span className="text-xs font-medium">{t("systools.optimize.queue.title")}</span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {count > 0
          ? t("systools.optimize.queue.count", { count })
          : t("systools.optimize.queue.empty")}
      </span>

      <Button
        variant="ghost"
        size="sm"
        className="ml-1"
        disabled={busy || bulkEligibleCount === 0}
        onClick={onOptimizeAll}
      >
        <Sparkles className="size-4" />
        {t("systools.optimize.actions.optimize")}
      </Button>

      <Button variant="ghost" size="sm" disabled={busy || count === 0} onClick={onClear}>
        {t("systools.optimize.actions.clear")}
      </Button>

      <Button size="sm" className="ml-auto" disabled={busy || count === 0} onClick={onApply}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {t("systools.optimize.actions.apply")}
      </Button>
    </div>
  );
}
