// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One virtualized line of the process table. Memoized on the fields it prints:
// a snapshot every second replaces every row object, but only rows whose
// visible values changed are re-rendered.

import { memo } from "react";
import { ChevronRight, Leaf } from "lucide-react";
import type { ProcessTableRow } from "@/lib/task-manager/process-sections";
import { formatBytes, formatPercent, formatRate } from "@/components/task-manager/format";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ProcessContextMenuContent, type ProcessActions } from "./process-context-menu";

/** Shared by the header and every row, so the columns stay aligned. */
export const PROCESS_GRID_COLUMNS =
  "grid-cols-[minmax(180px,1fr)_56px_64px_84px_108px_84px_56px_minmax(72px,112px)_80px]";

/** How far one tree level indents, and the depth where the indent stops. */
const INDENT_PX = 14;
const MAX_INDENT_DEPTH = 10;

export type ProcessRowViewProps = {
  row: ProcessTableRow;
  selected: boolean;
  showNetwork: boolean;
  actions: ProcessActions;
  /** `openDetail` is false for a right-click, which only marks the row. */
  onSelect: (row: ProcessTableRow, openDetail: boolean) => void;
  onToggle: (row: ProcessTableRow) => void;
};

function ProcessRowViewComponent({
  row,
  selected,
  showNetwork,
  actions,
  onSelect,
  onToggle,
}: ProcessRowViewProps) {
  const { t } = useAppTranslation();
  const group = row.kind === "group";
  const diskTotal =
    row.diskRead === null && row.diskWrite === null
      ? null
      : (row.diskRead ?? 0) + (row.diskWrite ?? 0);
  const detail = row.detail ?? (row.label !== row.process.name ? row.process.name : null);

  const content = (
    <div
      role="row"
      aria-selected={selected}
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        if (group) onToggle(row);
        else onSelect(row, true);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (group) onToggle(row);
        else onSelect(row, true);
      }}
      className={cn(
        "border-border/50 grid h-8 cursor-default items-center border-b text-xs transition-colors",
        PROCESS_GRID_COLUMNS,
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
        row.suspended && "text-muted-foreground"
      )}
    >
      <div
        role="gridcell"
        className="flex min-w-0 items-center gap-1.5 pr-2"
        style={{ paddingLeft: `${8 + Math.min(row.depth, MAX_INDENT_DEPTH) * INDENT_PX}px` }}
      >
        {row.expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={t(
              row.expanded ? "taskManager.process.collapse" : "taskManager.process.expand"
            )}
            aria-expanded={row.expanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(row);
            }}
            className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", row.expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden />
        )}
        {row.efficiency > 0 && (
          <Leaf
            aria-label={t("taskManager.process.efficiency")}
            className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        )}
        <span
          className="min-w-0 truncate font-medium"
          title={`${row.label}\n${row.process.path ?? row.process.name}`}
        >
          {row.label}
        </span>
        {detail && <span className="text-muted-foreground min-w-0 truncate">{detail}</span>}
        {group && (
          <span className="bg-muted text-muted-foreground ml-auto shrink-0 rounded px-1.5 font-mono text-[10px] tabular-nums">
            {row.count}
          </span>
        )}
      </div>

      <div
        role="gridcell"
        className="text-muted-foreground truncate px-2 text-right font-mono tabular-nums"
      >
        {group ? "—" : row.process.pid}
      </div>
      <div role="gridcell" className="px-2 text-right font-mono tabular-nums">
        {formatPercent(row.cpu)}
      </div>
      <div role="gridcell" className="px-2 text-right font-mono tabular-nums">
        {formatBytes(row.mem)}
      </div>
      <div
        role="gridcell"
        className="text-muted-foreground truncate px-2 text-right font-mono tabular-nums"
        title={
          diskTotal === null
            ? t("taskManager.process.column.diskUnavailable")
            : t("taskManager.process.diskRates", {
                read: formatRate(row.diskRead ?? 0),
                write: formatRate(row.diskWrite ?? 0),
              })
        }
      >
        {diskTotal === null ? "—" : formatRate(diskTotal)}
      </div>
      <div
        role="gridcell"
        className="text-muted-foreground truncate px-2 text-right font-mono tabular-nums"
        title={
          showNetwork
            ? t("taskManager.process.netRates", {
                sent: formatRate(row.netSent),
                received: formatRate(row.netReceived),
              })
            : t("taskManager.process.column.netUnavailable")
        }
      >
        {showNetwork ? formatRate(row.netSent + row.netReceived) : "—"}
      </div>
      <div
        role="gridcell"
        className="px-2 text-right font-mono tabular-nums"
        title={row.gpuEngine ?? undefined}
      >
        {formatPercent(row.gpu)}
      </div>
      <div
        role="gridcell"
        className="text-muted-foreground truncate px-2"
        title={row.user ?? undefined}
      >
        {row.user ?? "—"}
      </div>
      <div role="gridcell" className="truncate px-2">
        {t(
          row.suspended
            ? "taskManager.process.status.suspended"
            : "taskManager.process.status.running"
        )}
      </div>
    </div>
  );

  if (group) return content;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={() => onSelect(row, false)}>
        {content}
      </ContextMenuTrigger>
      <ProcessContextMenuContent process={row.process} actions={actions} />
    </ContextMenu>
  );
}

function sameRow(previous: ProcessRowViewProps, next: ProcessRowViewProps): boolean {
  const left = previous.row;
  const right = next.row;
  return (
    previous.selected === next.selected &&
    previous.showNetwork === next.showNetwork &&
    previous.actions === next.actions &&
    previous.onSelect === next.onSelect &&
    previous.onToggle === next.onToggle &&
    left.key === right.key &&
    left.label === right.label &&
    left.detail === right.detail &&
    left.depth === right.depth &&
    left.kind === right.kind &&
    left.count === right.count &&
    left.expandable === right.expandable &&
    left.expanded === right.expanded &&
    left.cpu === right.cpu &&
    left.mem === right.mem &&
    left.diskRead === right.diskRead &&
    left.diskWrite === right.diskWrite &&
    left.netSent === right.netSent &&
    left.netReceived === right.netReceived &&
    left.gpu === right.gpu &&
    left.gpuEngine === right.gpuEngine &&
    left.user === right.user &&
    left.suspended === right.suspended &&
    left.efficiency === right.efficiency &&
    left.process.pid === right.process.pid &&
    left.process.path === right.process.path &&
    left.process.efficiency === right.process.efficiency
  );
}

export const ProcessRowView = memo(ProcessRowViewComponent, sameRow);
