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
import { PROCESS_GRID_COLUMNS, ProcessRowView } from "./process-row";

const ROW_HEIGHT = 32;

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
  { key: "disk", labelKey: "taskManager.process.column.disk", align: "right" },
  { key: "net", labelKey: "taskManager.process.column.net", align: "right" },
  { key: "gpu", labelKey: "taskManager.process.column.gpu", align: "right" },
  { key: null, labelKey: "taskManager.process.column.user", align: "left" },
  { key: null, labelKey: "taskManager.process.column.status", align: "left" },
];

export type ProcessTableProps = {
  rows: ProcessTableRow[];
  selectedKey: string | null;
  showNetwork: boolean;
  sort: ProcessSort;
  actions: ProcessActions;
  onSortChange: (sort: ProcessSort) => void;
  onSelect: (row: ProcessTableRow, openDetail: boolean) => void;
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
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
  });

  return (
    <div
      role="grid"
      aria-rowcount={rows.length}
      aria-label={t("taskManager.process.tableLabel")}
      className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
    >
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full min-w-[900px] flex-col">
          <div
            role="row"
            className={cn(
              "text-muted-foreground bg-muted/40 grid h-8 shrink-0 items-center border-b text-[11px] font-medium",
              PROCESS_GRID_COLUMNS
            )}
          >
            {COLUMNS.map((column) => (
              <HeaderCell
                key={column.labelKey}
                column={column}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
          </div>

          <div ref={scrollRef} role="rowgroup" className="min-h-0 flex-1 overflow-y-auto">
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
                      transform: `translateY(${item.start}px)`,
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
    </div>
  );
}
