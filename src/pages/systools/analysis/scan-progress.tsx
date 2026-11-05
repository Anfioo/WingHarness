import { Loader2, ScanSearch, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { AnalysisProgress } from "@/lib/systools/storage";
import { formatBytes, formatCount } from "@/lib/systools/format";
import { cn } from "@/lib/utils";

const STAGE_KEYS: Readonly<Record<string, string>> = {
  analyzing: "systools.analysis.stage.analyzing",
  validatingFiles: "systools.analysis.stage.validatingFiles",
  hashingFiles: "systools.analysis.stage.hashingFiles",
};

type ScanProgressProps = {
  progress: AnalysisProgress | null;
  cancelling: boolean;
  /** Strip keeps the previous result visible while a rescan runs. */
  variant?: "panel" | "strip";
  onCancel: () => void;
};

/** Determinate when the native scan reports steps, indeterminate otherwise. */
export function ScanProgress({
  progress,
  cancelling,
  variant = "panel",
  onCancel,
}: ScanProgressProps) {
  const { t, language } = useAppTranslation();
  const completedSteps = progress?.completedSteps ?? 0;
  const totalSteps = progress?.totalSteps ?? 0;
  const determinate = totalSteps > 0;
  const percent = determinate ? Math.min(100, Math.max(0, (completedSteps / totalSteps) * 100)) : 0;
  const stageKey = progress?.currentStage ? STAGE_KEYS[progress.currentStage] : undefined;
  const stage = stageKey ? t(stageKey) : t("systools.analysis.stage.analyzing");
  const cancelLabel = cancelling
    ? t("systools.analysis.toolbar.cancelling")
    : t("systools.analysis.toolbar.cancel");

  if (variant === "strip") {
    return (
      <div className="shrink-0 border-b px-3 py-1.5" data-slot="analysis-progress-strip">
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          <Loader2
            className="text-muted-foreground size-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
          <span className="shrink-0 font-medium">{stage}</span>
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate"
            title={progress?.currentPath}
          >
            {progress?.currentPath}
          </span>
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {formatBytes(progress?.bytesScanned ?? 0, language)}
            {" · "}
            {formatCount(progress?.itemsScanned ?? 0, language)}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Square className="size-3" />
            )}
            {cancelLabel}
          </Button>
        </div>
        <Progress
          value={determinate ? percent : 0}
          className={cn("mt-1 h-1", !determinate && "animate-pulse")}
        />
      </div>
    );
  }

  return (
    <div
      className="flex h-full items-center justify-center px-6 py-8"
      data-slot="analysis-progress"
    >
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-full">
            <ScanSearch className="text-muted-foreground size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{stage}</p>
            <p className="text-muted-foreground truncate text-[11px]" title={progress?.currentPath}>
              {progress?.currentPath || t("systools.analysis.stage.analyzing")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            onClick={onCancel}
            disabled={cancelling}
          >
            {cancelling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Square className="size-3.5" />
            )}
            {cancelLabel}
          </Button>
        </div>

        <div className="space-y-1">
          <Progress
            value={determinate ? percent : 0}
            className={cn("h-1.5", !determinate && "animate-pulse")}
          />
          <p className="text-muted-foreground text-right text-[10px] tabular-nums">
            {determinate
              ? t("systools.analysis.progress.steps", {
                  completed: formatCount(completedSteps, language),
                  total: formatCount(totalSteps, language),
                })
              : t("systools.analysis.progress.indeterminate")}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-muted/40 rounded-md border px-3 py-2">
            <dt className="text-muted-foreground text-[10px]">
              {t("systools.analysis.progress.scanned")}
            </dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {formatBytes(progress?.bytesScanned ?? 0, language)}
            </dd>
            <dd className="text-muted-foreground text-[10px] tabular-nums">
              {t("systools.analysis.progress.items", {
                count: progress?.itemsScanned ?? 0,
              })}
            </dd>
          </div>
          <div className="bg-muted/40 rounded-md border px-3 py-2">
            <dt className="text-muted-foreground text-[10px]">
              {t("systools.analysis.progress.found")}
            </dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {formatBytes(progress?.foundBytes ?? 0, language)}
            </dd>
            <dd className="text-muted-foreground text-[10px] tabular-nums">
              {t("systools.analysis.progress.items", {
                count: progress?.foundItems ?? 0,
              })}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
