// Small pill that states a health level, used by metric cards, signals and the
// history rows. The label defaults to the level's name so callers only pass one
// when they are showing a status that is not the level itself.

import type { MiseHealthLevel } from "@/commands";
import type { StatusBadgeProps } from "@/components/mise/props";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { levelLabelKey } from "@/lib/mise/format";
import { cn } from "@/lib/utils";

const LEVEL_CLASS: Record<MiseHealthLevel, string> = {
  healthy: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  info: "border-border bg-muted text-muted-foreground",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  critical: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function StatusBadge({ level, label }: StatusBadgeProps) {
  const { t } = useAppTranslation();

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        LEVEL_CLASS[level]
      )}
    >
      {label ?? t(levelLabelKey(level))}
    </span>
  );
}
