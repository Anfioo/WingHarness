// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The shared frame of every performance panel: a titled card with an even
// rhythm, and the small stat and empty-state blocks the panels repeat.

import type { ReactNode } from "react";
import type { Snapshot } from "@/commands";
import type { ChartHistory } from "@/lib/task-manager/chart-history";
import { cn } from "@/lib/utils";

/** What every chart panel reads: the newest frame, the rolling window and the sampling interval. */
export type PerformanceData = {
  snapshot: Snapshot;
  history: ChartHistory;
  /** Sampling interval, ms: the window spans `HISTORY_SAMPLES` of them. */
  intervalMs: number;
};

/** The title row of one device's detail view, with its controls on the right. */
export function PerformanceDetailHeader({
  title,
  model,
  children,
}: {
  title: string;
  model?: string | null;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <h2 className="shrink-0 text-[24px] font-semibold tracking-tight">{title}</h2>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
        {model && (
          <p className="text-muted-foreground min-w-0 truncate text-sm" title={model}>
            {model}
          </p>
        )}
        {children}
      </div>
    </header>
  );
}

/** A small set of mutually exclusive choices, styled like a segmented button. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="border-border bg-muted/50 inline-flex items-center gap-0.5 rounded-md border p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The live figures beside the processor facts, as on the Argus page: the
 * figures take the slightly wider column, the facts the other one.
 */
export function PerformanceSummary({ children }: { children: ReactNode }) {
  return (
    <div className="grid content-start gap-7 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {children}
    </div>
  );
}

export function PerformanceStats({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] content-start gap-x-5 gap-y-3.5">
      {children}
    </div>
  );
}

/** Label/value rows for the slow-changing facts under a detail view. */
export function PerformanceSpecs({ children }: { children: ReactNode }) {
  return (
    <dl className="grid content-start gap-x-5 gap-y-1.5 text-xs sm:grid-cols-2">{children}</dl>
  );
}

export function PerformanceSpec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="min-w-0 truncate text-right tabular-nums">{children}</dd>
    </div>
  );
}

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
      className="border-border bg-card flex scroll-mt-3 flex-col gap-3 rounded-lg border p-3"
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
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-[20px] leading-tight font-semibold tabular-nums">{value}</span>
      {detail && <span className="text-muted-foreground truncate text-xs">{detail}</span>}
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
