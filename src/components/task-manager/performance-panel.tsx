// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The shared frame of every performance panel: a titled card with an even
// rhythm, and the small stat and empty-state blocks the panels repeat.

import type { ReactNode } from "react";
import type { Snapshot } from "@/commands";
import type { ChartHistory } from "@/lib/task-manager/chart-history";
import { cn } from "@/lib/utils";

/** What every chart panel reads: the newest frame and the rolling window. */
export type PerformanceData = {
  snapshot: Snapshot;
  history: ChartHistory;
};

export function PerformancePanel({
  id,
  title,
  description,
  children,
}: {
  /** Scroll target for the summary card. */
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className="border-border bg-card flex scroll-mt-3 flex-col gap-3 rounded-xl border p-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <span className="text-muted-foreground truncate text-xs" title={description}>
            {description}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

export function PerformanceStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <span className="text-lg leading-tight font-semibold tabular-nums">{value}</span>
      {detail && <span className="text-muted-foreground truncate text-[11px]">{detail}</span>}
    </div>
  );
}

export function PerformanceEmpty({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-muted-foreground border-border rounded-lg border border-dashed px-3 py-6 text-center text-xs",
        className
      )}
    >
      {children}
    </p>
  );
}
