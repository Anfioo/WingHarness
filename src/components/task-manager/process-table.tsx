// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The virtualized process table: one sticky header, then only the rows near
// the viewport. The three views differ in their rows, never in this component.

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  SORT_DESC_FIRST,
  type ProcessSort,
  type ProcessSortKey,
  type ProcessTableRow,
} from "@/lib/task-manager/process-sections";
import { cn } from "@/lib/utils";
import type { ProcessActions } from "./process-context-menu";
import { ProcessRowView, processGridColumns } from "./process-row";

const ROW_HEIGHT = 32;
/** The sticky header sits above the rows inside the same scroller. */
const HEADER_HEIGHT = 32;

type Column = {
  key: ProcessSortKey | null;
  labelKey: string;
  align: "left" | "right";
};

const COLUMNS: readonly Column[] = [
  { key: "name", labelKey: "taskManager.process.column.name", align: "left" },
  { key: "pid", labelKey: "taskManager.process.column.pid", align: "right" },
  { key: "cpu", labelKey: "taskManager.process.column.cpu", align: "right" },
  { key: "mem", labelKey: "taskManager.process.column.mem", align: "right" },
  { key: "diskRead", labelKey: "taskManager.process.column.diskRead", align: "right" },
  { key: "diskWrite", labelKey: "taskManager.process.column.diskWrite", align: "right" },
  { key: "io", labelKey: "taskManager.process.column.io", align: "right" },
  { key: "gpu", labelKey: "taskManager.process.column.gpu", align: "right" },
  { key: "threads", labelKey: "taskManager.process.column.threads", align: "right" },
  { key: "handles", labelKey: "taskManager.process.column.handles", align: "right" },
];

/** Only measured with the privileged service; hidden rather than shown empty. */
const NET_COLUMN: Column = {
  key: "net",
  labelKey: "taskManager.process.column.net",
  align: "right",
};

function columnsFor(showNetwork: boolean): readonly Column[] {
  if (!showNetwork) return COLUMNS;
  const gpuIndex = COLUMNS.findIndex((column) => column.key === "gpu");
  return [...COLUMNS.slice(0, gpuIndex + 1), NET_COLUMN, ...COLUMNS.slice(gpuIndex + 1)];
}

export type ProcessTableProps = {
  rows: ProcessTableRow[];
  selectedKey: string | null;
  showNetwork: boolean;
  sort: ProcessSort;
  actions: ProcessActions;
  onSortChange: (sort: ProcessSort) => void;
  onSelect: (row: ProcessTableRow) => void;
  onToggle: (row: ProcessTableRow) => void;
};

function HeaderCell({
  column,
  sort,
  onSortChange,
}: {
  column: Column;
  sort: ProcessSort;
  onSortChange: (sort: ProcessSort) => void;
}) {
  const { t } = useAppTranslation();
  const active = column.key !== null && sort.key === column.key;
  const content = (
    <>
      <span className="truncate">{t(column.labelKey)}</span>
      {active &&
        (sort.desc ? (
          <ArrowDown className="size-3 shrink-0" aria-hidden />
        ) : (
          <ArrowUp className="size-3 shrink-0" aria-hidden />
        ))}
    </>
  );
  const className = cn(
    "flex min-w-0 items-center gap-1 px-2",
    column.align === "right" && "justify-end"
  );

  if (column.key === null) {
    return (
      <div role="columnheader" className={className}>
        {content}
      </div>
    );
  }

  const key = column.key;
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
      onClick={() =>
        onSortChange(active ? { key, desc: !sort.desc } : { key, desc: SORT_DESC_FIRST[key] })
      }
      className={cn(
        className,
        "hover:text-foreground focus-visible:ring-ring/50 rounded transition-colors focus-visible:ring-2 focus-visible:outline-none"
      )}
    >
      {content}
    </button>
  );
}

export function ProcessTable({
  rows,
  selectedKey,
  showNetwork,
  sort,
  actions,
  onSortChange,
  onSelect,
  onToggle,
}: ProcessTableProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = columnsFor(showNetwork);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
    // The header is part of the scrolled content; the window starts below it.
    scrollMargin: HEADER_HEIGHT,
  });

  return (
    <div
      role="grid"
      aria-rowcount={rows.length}
      aria-label={t("taskManager.process.tableLabel")}
      className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
    >
      {/* One scroller for both axes: the sticky header keeps the columns
          aligned with the rows, and the vertical scrollbar stays at the
          viewport edge even while the table is wider than the pane. */}
      <div ref={scrollRef} role="rowgroup" className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[980px]">
          <div
            role="row"
            className={cn(
              "text-muted-foreground bg-muted sticky top-0 z-10 grid h-8 items-center border-b text-[11px] font-medium",
              processGridColumns(showNetwork)
            )}
          >
            {columns.map((column) => (
              <HeaderCell
                key={column.labelKey}
                column={column}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
          </div>

          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start - HEADER_HEIGHT}px)`,
                  }}
                >
                  <ProcessRowView
                    row={row}
                    selected={row.kind === "process" && row.key === selectedKey}
                    showNetwork={showNetwork}
                    actions={actions}
                    onSelect={onSelect}
                    onToggle={onToggle}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
