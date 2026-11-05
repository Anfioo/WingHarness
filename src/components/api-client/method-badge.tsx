import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A compact, colour-coded chip for an HTTP verb. Unknown or custom verbs fall
 * back to a neutral chip. Every colour pairs a readable foreground with a
 * translucent background and border, so the chip stays legible in both light
 * and dark themes.
 */
const METHOD_CLASSES: Record<string, string> = {
  GET: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  POST: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  PUT: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  PATCH: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  DELETE: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  HEAD: "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400",
  OPTIONS: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
};

const FALLBACK_CLASSES = "border-border bg-muted text-muted-foreground";

export interface MethodBadgeProps {
  /** The HTTP verb; matched case-insensitively (`"get"` renders as `GET`). */
  method: string;
  className?: string;
}

/** Fixed-width chip so verbs line up in the collection tree. */
export function MethodBadge({ method, className }: MethodBadgeProps): ReactNode {
  const label = method.trim().toUpperCase() || "—";
  return (
    <span
      data-slot="method-badge"
      className={cn(
        "inline-flex h-4 min-w-11 shrink-0 items-center justify-center rounded border px-1 font-mono text-[10px] leading-none font-semibold tracking-tight uppercase",
        METHOD_CLASSES[label] ?? FALLBACK_CLASSES,
        className
      )}
      title={label}
    >
      {label}
    </span>
  );
}

export default MethodBadge;
