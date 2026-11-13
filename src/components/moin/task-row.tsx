// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useRef } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import type { MoinCategory, MoinTask, MoinTaskProgress, MoinTaskStatus } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { SegmentBar } from "./segment-bar";

/**
 * One row of the download list.
 *
 * Column order matches the table header in `task-list.tsx`. Everything except
 * the name, the status and the row actions is hidden below `md`, where a
 * nine-column grid would be unreadable; the same values stay reachable in the
 * expanded panel. The whole row toggles that panel, so the disclosure control
 * it used to carry is now the trailing action cluster.
 */
export const ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 " +
  "md:grid-cols-[auto_minmax(0,1fr)_6.5rem_8rem_7rem_5.5rem_5rem_8rem_4.25rem]";

export const STATUS_KEYS: Record<MoinTaskStatus, string> = {
  queued: "moin.status.queued",
  connecting: "moin.status.connecting",
  downloading: "moin.status.downloading",
  paused: "moin.status.paused",
  moving: "moin.status.moving",
  completed: "moin.status.completed",
  failed: "moin.status.failed",
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
  return task.status === "failed" || task.status === "canceled";
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
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}

export function TaskRow({
  task,
  progress,
  category,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
  onPause,
  onResume,
  onDelete,
}: TaskRowProps) {
  const { t } = useAppTranslation();
  const received = progress?.received ?? task.received;
  const total = progress?.total ?? task.total;
  const completion = percent(received, total);
  // Live figures only exist while the engine is transferring; a completed or
  // paused task keeps its last tick in `progress`, so the status gates them.
  const live = isActiveStatus(task.status) && progress !== undefined;
  const pausable = canPause(task);
  const resumable = canResume(task);
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
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={() => onToggleExpand(task.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onToggleExpand(task.id);
      }}
      className={cn(
        "focus-visible:ring-ring/50 cursor-pointer border-b transition-colors outline-none last:border-b-0 focus-visible:ring-2",
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

        <div className="text-muted-foreground hidden text-xs tabular-nums md:block">
          {completion === null ? "—" : formatPercent(completion)}
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

        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!pausable && !resumable}
            aria-label={pausable ? t("moin.action.pause") : t("moin.action.resume")}
            onClick={(event) => {
              event.stopPropagation();
              if (pausable) onPause();
              else if (resumable) onResume();
            }}
          >
            {pausable ? <Pause /> : <Play />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            disabled={isActiveStatus(task.status)}
            aria-label={t("moin.action.delete")}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {progress && task.status !== "completed" && (
        <div className="px-3 pb-2">
          <SegmentBar progress={progress} />
        </div>
      )}

      {expanded && (
        <dl
          onClick={(event) => event.stopPropagation()}
          className="text-muted-foreground grid gap-1.5 px-3 pb-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3"
        >
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
