// One headline number on the overview: an icon, the label, the value and a
// caption. The health level only tints the left edge and the icon, so a long
// value or caption may wrap without pushing anything out of the card.

import type { MiseHealthLevel } from "@/commands";
import type { MetricCardProps } from "@/components/mise/props";
import { cn } from "@/lib/utils";

const LEVEL_BAR: Record<MiseHealthLevel, string> = {
  healthy: "bg-emerald-500",
  info: "bg-sky-500",
  warning: "bg-amber-500",
  critical: "bg-destructive",
};

const LEVEL_ICON: Record<MiseHealthLevel, string> = {
  healthy: "text-emerald-600",
  info: "text-sky-600",
  warning: "text-amber-600",
  critical: "text-destructive",
};

export function MetricCard({ label, value, caption, level, icon: Icon }: MetricCardProps) {
  return (
    <div className="border-border bg-card relative overflow-hidden rounded-xl border">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", LEVEL_BAR[level])} />
      <div className="flex min-w-0 flex-col gap-1.5 p-4 pl-5">
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs font-medium">
          {Icon && <Icon className={cn("size-4 shrink-0", LEVEL_ICON[level])} />}
          <span className="min-w-0 break-words">{label}</span>
        </div>
        <span className="text-foreground text-2xl leading-tight font-semibold break-words tabular-nums">
          {value}
        </span>
        {caption && (
          <span className="text-muted-foreground text-xs leading-relaxed break-words whitespace-pre-line">
            {caption}
          </span>
        )}
      </div>
    </div>
  );
}
