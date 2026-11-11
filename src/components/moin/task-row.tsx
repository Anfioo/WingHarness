// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MoinCategory, MoinTask, MoinTaskProgress, MoinTaskStatus } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  formatBytes,
  formatDate,
  formatEta,
  formatPercent,
  formatSpeed,
  percent,
} from "@/lib/moin/format";
import { cn } from "@/lib/utils";

/**
 * One row of the download list.
 *
 * Column order matches the table header in `task-list.tsx`. Everything except
 * the name, the status and the disclosure control is hidden below `md`, where a
 * nine-column grid would be unreadable; the same values stay reachable in the
 * expanded panel.
 */
export const ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 " +
  "md:grid-cols-[auto_minmax(0,1fr)_6.5rem_8rem_7rem_5.5rem_5rem_8rem_auto]";

export const STATUS_KEYS: Record<MoinTaskStatus, string> = {
  queued: "moin.status.queued",
  connecting: "moin.status.connecting",
  downloading: "moin.status.downloading",
  paused: "moin.status.paused",
  moving: "moin.status.moving",
  completed: "moin.status.completed",
  failed: "moin.status.failed",
  stalled: "moin.status.stalled",
  canceled: "moin.status.canceled",
};

export const STATUS_STYLES: Record<MoinTaskStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  connecting: "bg-primary/10 text-primary",
  downloading: "bg-primary/10 text-primary",
  paused: "bg-muted text-muted-foreground",
  moving: "bg-primary/10 text-primary",
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  stalled: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  canceled: "bg-muted text-muted-foreground",
};

/** Statuses the engine still owns a transfer for. */
const ACTIVE_STATUSES: MoinTaskStatus[] = ["queued", "connecting", "downloading", "moving"];

export function isActiveStatus(status: MoinTaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

// Capability gates. They mirror the engine state machine: an action offered for
// a status the engine rejects would only surface as a `conflict` toast.

export function canPause(task: MoinTask): boolean {
  return task.status === "queued" || task.status === "connecting" || task.status === "downloading";
}

export function canResume(task: MoinTask): boolean {
  return task.status === "paused";
}

export function canRetry(task: MoinTask): boolean {
  return task.status === "failed" || task.status === "stalled" || task.status === "canceled";
}

export function canCancel(task: MoinTask): boolean {
  return (
    task.status === "queued" ||
    task.status === "connecting" ||
    task.status === "downloading" ||
    task.status === "paused"
  );
}

export function canReveal(task: MoinTask): boolean {
  return task.status === "completed";
}

/** Native checkbox with an indeterminate state, used by the row and the header. */
export function SelectionCheckbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => onCheckedChange(event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      className="border-input accent-primary size-4 shrink-0 cursor-pointer rounded border"
    />
  );
}

export interface TaskRowProps {
  task: MoinTask;
  progress?: MoinTaskProgress;
  category?: MoinCategory;
  selected: boolean;
  expanded: boolean;
  onToggleSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
}

export function TaskRow({
  task,
  progress,
  category,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
}: TaskRowProps) {
  const { t } = useAppTranslation();
  const received = progress?.received ?? task.received;
  const total = progress?.total ?? task.total;
  const completion = percent(received, total);
  // Live figures only exist while the engine is transferring; a completed or
  // paused task keeps its last tick in `progress`, so the status gates them.
  const live = isActiveStatus(task.status) && progress !== undefined;
  const speed = live ? formatSpeed(progress.speed) : "—";
  const eta =
    live && progress.total !== null
      ? formatEta(Math.max(0, progress.total - progress.received), progress.speed)
      : "—";
  const averageSpeed =
    task.active_ms > 0 ? formatSpeed(task.received / (task.active_ms / 1000)) : "—";
  const backendLabel =
    task.backend === "embedded"
      ? t("moin.backend.embedded")
      : task.backend === "aria2"
        ? t("moin.backend.aria2")
        : task.backend;

  return (
    <div
      className={cn(
        "border-b transition-colors last:border-b-0",
        selected ? "bg-primary/5" : "hover:bg-accent/40"
      )}
    >
      <div className={cn(ROW_GRID, "px-3 py-2")}>
        <SelectionCheckbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(task.id)}
          label={task.filename}
        />

        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: category?.color || "var(--color-muted-foreground)" }}
            />
            <span className="min-w-0 truncate text-sm font-medium" title={task.filename}>
              {task.filename}
            </span>
            {backendLabel && (
              <Badge variant="outline" className="hidden shrink-0 lg:inline-flex">
                {backendLabel}
              </Badge>
            )}
            {task.archived && (
              <Badge variant="secondary" className="shrink-0">
                {t("moin.filter.archived")}
              </Badge>
            )}
            {/* Below `md` the status column is hidden, so the badge moves here. */}
            <span
              className={cn(
                "inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium md:hidden",
                STATUS_STYLES[task.status]
              )}
            >
              {t(STATUS_KEYS[task.status])}
            </span>
          </div>
          <p className="text-muted-foreground truncate text-xs" title={task.url}>
            {task.url}
          </p>
        </div>

        <div className="hidden md:block">
          <span
            className={cn(
              "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
              STATUS_STYLES[task.status]
            )}
          >
            {t(STATUS_KEYS[task.status])}
          </span>
        </div>

        <div className="hidden min-w-0 md:block">
          {completion === null ? (
            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
              <div className="bg-primary h-full w-1/3 animate-pulse rounded-full" />
            </div>
          ) : (
            <Progress value={completion} aria-label={t("moin.task.progress")} className="h-1.5" />
          )}
          <span className="text-muted-foreground mt-1 block text-[11px] tabular-nums">
            {completion === null ? "—" : formatPercent(completion)}
          </span>
        </div>

        <div className="text-muted-foreground hidden text-xs tabular-nums md:block">
          <span className="block truncate">
            {formatBytes(received)} / {formatBytes(total)}
          </span>
        </div>

        <div className="text-muted-foreground hidden text-xs tabular-nums md:block">{speed}</div>

        <div className="text-muted-foreground hidden text-xs tabular-nums md:block">{eta}</div>

        <div className="text-muted-foreground hidden truncate text-xs tabular-nums md:block">
          {formatDate(task.created_at)}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t("moin.task.collapseAria", { filename: task.filename })
              : t("moin.task.expandAria", { filename: task.filename })
          }
          onClick={() => onToggleExpand(task.id)}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
      </div>

      {expanded && (
        <dl className="text-muted-foreground grid gap-1.5 px-3 pb-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
          <dt className="font-medium">{t("moin.task.path")}</dt>
          <dd className="text-foreground min-w-0 break-all">{task.dest}</dd>

          {task.error && (
            <>
              <dt className="font-medium">{t("moin.task.error")}</dt>
              <dd className="text-destructive min-w-0 break-words">{task.error}</dd>
            </>
          )}

          <dt className="font-medium">{t("moin.task.category")}</dt>
          <dd className="text-foreground">{category?.name ?? "—"}</dd>

          <dt className="font-medium">{t("moin.task.backend")}</dt>
          <dd className="text-foreground">{backendLabel ?? "—"}</dd>

          <dt className="font-medium">{t("moin.task.avgSpeed")}</dt>
          <dd className="text-foreground tabular-nums">{averageSpeed}</dd>
        </dl>
      )}
    </div>
  );
}
