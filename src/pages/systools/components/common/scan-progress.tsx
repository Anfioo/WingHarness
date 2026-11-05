import { Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type ScanStat = { label: string; value: string };

type ScanProgressViewProps = {
  title: string;
  label: string;
  currentPath?: string;
  percent: number;
  determinate: boolean;
  cancelling: boolean;
  cancelLabel: string;
  cancellingLabel: string;
  description: string;
  stats: ScanStat[];
  onCancel: () => void;
};

/** Full-workspace progress shown while a tab has no previous result to keep. */
export function ScanProgressView({
  title,
  label,
  currentPath,
  percent,
  determinate,
  cancelling,
  cancelLabel,
  cancellingLabel,
  description,
  stats,
  onCancel,
}: ScanProgressViewProps) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      <div
        className="bg-card w-full max-w-md space-y-4 rounded-xl border p-6 shadow-sm"
        aria-busy="true"
      >
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-full">
            <Loader2 className="size-5 animate-spin" />
          </div>
          <div className="min-w-0">
            <p className="text-muted-foreground text-[11px] font-medium">{label}</p>
            <h2 className="truncate text-base font-semibold">{title}</h2>
          </div>
        </div>

        <p
          className="text-muted-foreground truncate text-xs"
          role="status"
          aria-live="polite"
          title={currentPath}
        >
          {currentPath}
        </p>

        <Progress value={percent} className={cn("h-1", !determinate && "animate-pulse")} />

        <dl className="grid grid-cols-3 gap-2">
          {stats.map((stat) => (
            <ScanStatCell key={stat.label} label={stat.label} value={stat.value} />
          ))}
        </dl>

        <p className="text-muted-foreground text-[11px] leading-relaxed">{description}</p>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onCancel}
          disabled={cancelling}
        >
          {cancelling ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Square className="size-3.5" />
          )}
          {cancelling ? cancellingLabel : cancelLabel}
        </Button>
      </div>
    </div>
  );
}

type ScanProgressStripProps = {
  title: string;
  currentPath?: string;
  summary: string;
  percent: number;
  determinate: boolean;
  cancelling?: boolean;
  cancelLabel?: string;
  cancellingLabel?: string;
  onCancel?: () => void;
};

/** Compact progress kept above the previous result while a rescan runs. */
export function ScanProgressStrip({
  title,
  currentPath,
  summary,
  percent,
  determinate,
  cancelling = false,
  cancelLabel,
  cancellingLabel,
  onCancel,
}: ScanProgressStripProps) {
  return (
    <div className="shrink-0 border-b px-3 py-1.5" aria-busy="true">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span className="shrink-0 font-medium">{title}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate" title={currentPath}>
          {currentPath}
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">{summary}</span>
        {onCancel ? (
          <Button variant="ghost" size="xs" onClick={onCancel} disabled={cancelling}>
            {cancelling ? cancellingLabel : cancelLabel}
          </Button>
        ) : null}
      </div>
      <Progress value={percent} className={cn("mt-1 h-0.5", !determinate && "animate-pulse")} />
    </div>
  );
}

function ScanStatCell({ label, value }: ScanStat) {
  return (
    <div className="bg-muted/60 min-w-0 rounded-md px-2 py-1.5">
      <dt className="text-muted-foreground truncate text-[10px]">{label}</dt>
      <dd className="truncate text-[13px] font-medium tabular-nums">{value}</dd>
    </div>
  );
}
