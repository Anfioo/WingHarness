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
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        {model && (
          <p className="text-muted-foreground truncate text-xs" title={model}>
            {model}
          </p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
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
      className="border-border bg-card flex items-center gap-0.5 rounded-lg border p-[3px]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === option.value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Label/value rows for the slow-changing facts under a detail view. */
export function PerformanceSpecs({ children }: { children: ReactNode }) {
  return (
    <dl className="border-border/60 grid gap-x-4 gap-y-1.5 border-t pt-3 text-xs sm:grid-cols-2">
      {children}
    </dl>
  );
}

export function PerformanceSpec({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
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
