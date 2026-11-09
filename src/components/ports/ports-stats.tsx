// The ports page's three-state counters and the bar showing their share.

import type { PortStatus } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import type { PortsStatsProps } from "./props";

const STATUS_ORDER: PortStatus[] = ["free", "occupied", "system"];

const STATUS_DOT: Record<PortStatus, string> = {
  free: "bg-emerald-500",
  occupied: "bg-amber-500",
  system: "bg-slate-400",
};

const STATUS_LABEL_KEY: Record<PortStatus, string> = {
  free: "ports.status.free",
  occupied: "ports.status.occupied",
  system: "ports.status.system",
};

/** Free / occupied / system counts over the visible ports, plus their proportion bar. */
export function PortsStats({ counts }: PortsStatsProps) {
  const { t } = useAppTranslation();
  const total = counts.free + counts.occupied + counts.system;

  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="divide-border grid grid-cols-3 divide-x">
        {STATUS_ORDER.map((status) => (
          <div key={status} className="flex flex-col gap-2 px-4 py-3.5">
            <div className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
              <span className="text-muted-foreground text-[11.5px] font-medium">
                {t(STATUS_LABEL_KEY[status])}
              </span>
            </div>
            <span className="text-foreground font-mono text-[26px] leading-none font-medium tracking-[-0.03em] tabular-nums">
              {counts[status]}
            </span>
          </div>
        ))}
      </div>
      <div className="bg-border/60 flex h-[3px] w-full gap-px" aria-hidden>
        {STATUS_ORDER.map((status) =>
          counts[status] > 0 ? (
            <div
              key={status}
              className={cn(STATUS_DOT[status], "opacity-80")}
              style={{ width: `${(counts[status] / total) * 100}%` }}
            />
          ) : null
        )}
      </div>
    </div>
  );
}
