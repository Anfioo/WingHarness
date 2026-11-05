import { AlertTriangle, CheckCircle2, CircleHelp, XCircle, type LucideIcon } from "lucide-react";
import type { SyncStatus } from "@/commands";
import { cn } from "@/lib/utils";

const STATUS_META: Record<SyncStatus, { icon: LucideIcon; className: string }> = {
  "in-sync": {
    icon: CheckCircle2,
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  drift: { icon: AlertTriangle, className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  unconfirmed: { icon: CircleHelp, className: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  error: { icon: XCircle, className: "bg-destructive/15 text-destructive" },
};

/** The TUI's `● ▲ ◐ ✕` sync glyph, as a SHADCN badge. */
export function StatusBadge({ status, label }: { status: SyncStatus; label: string }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        meta.className
      )}
    >
      <Icon className="size-3" />
      {label}
    </span>
  );
}
