// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The services table: one sticky header, then a plain row per service. The
// list is small enough (a few hundred rows) that it is not virtualized.

import { ArrowDown, ArrowUp } from "lucide-react";
import type { ServiceInfo, ServiceState } from "@/commands";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ServiceSort, ServiceSortKey } from "@/lib/task-manager/service-rows";
import { cn } from "@/lib/utils";
import { ServiceContextMenuContent, type ServiceActions } from "./service-context-menu";

/** Shared by the header and every row, so the columns stay aligned. */
const SERVICE_GRID_COLUMNS =
  "grid-cols-[minmax(220px,1.3fr)_minmax(110px,0.6fr)_72px_104px_160px_minmax(200px,1.6fr)]";

type Column = { key: ServiceSortKey; labelKey: string; align: "left" | "right" };

const COLUMNS: readonly Column[] = [
  { key: "display", labelKey: "taskManager.services.column.display", align: "left" },
  { key: "name", labelKey: "taskManager.services.column.name", align: "left" },
  { key: "pid", labelKey: "taskManager.services.column.pid", align: "right" },
  { key: "state", labelKey: "taskManager.services.column.status", align: "left" },
  { key: "startType", labelKey: "taskManager.services.column.startType", align: "left" },
  { key: "description", labelKey: "taskManager.services.column.description", align: "left" },
];

const STATE_DOT: Record<ServiceState, string> = {
  running: "bg-emerald-500",
  stopped: "bg-muted-foreground/50",
  startPending: "bg-amber-500",
  stopPending: "bg-amber-500",
  continuePending: "bg-amber-500",
  pausePending: "bg-amber-500",
  paused: "bg-amber-500",
};

export type ServiceTableProps = {
  rows: ServiceInfo[];
  selectedName: string | null;
  sort: ServiceSort;
  actions: ServiceActions;
  onSortChange: (sort: ServiceSort) => void;
  onSelect: (name: string) => void;
};

function HeaderCell({
  column,
  sort,
  onSortChange,
}: {
  column: Column;
  sort: ServiceSort;
  onSortChange: (sort: ServiceSort) => void;
}) {
  const { t } = useAppTranslation();
  const active = sort.key === column.key;
  const key = column.key;
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
      onClick={() => onSortChange(active ? { key, desc: !sort.desc } : { key, desc: false })}
      className={cn(
        "hover:text-foreground focus-visible:ring-ring/50 flex min-w-0 items-center gap-1 px-2 transition-colors focus-visible:ring-2 focus-visible:outline-none",
        column.align === "right" && "justify-end"
      )}
    >
      <span className="truncate">{t(column.labelKey)}</span>
      {active &&
        (sort.desc ? (
          <ArrowDown className="size-3 shrink-0" aria-hidden />
        ) : (
          <ArrowUp className="size-3 shrink-0" aria-hidden />
        ))}
    </button>
  );
}

function ServiceRowView({
  service,
  selected,
  actions,
  onSelect,
}: {
  service: ServiceInfo;
  selected: boolean;
  actions: ServiceActions;
  onSelect: (name: string) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="row"
          aria-selected={selected}
          tabIndex={0}
          onClick={() => onSelect(service.name)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onSelect(service.name);
          }}
          className={cn(
            "border-border/50 grid h-8 cursor-default items-center border-b text-xs transition-colors",
            "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
            SERVICE_GRID_COLUMNS,
            selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
          )}
        >
          <div role="gridcell" className="min-w-0 px-2">
            <span className="block truncate font-medium" title={service.displayName}>
              {service.displayName}
            </span>
          </div>
          <div role="gridcell" className="min-w-0 px-2">
            <span
              className="text-muted-foreground block truncate font-mono text-[11px]"
              title={service.name}
            >
              {service.name}
            </span>
          </div>
          <div
            role="gridcell"
            className="text-muted-foreground px-2 text-right tabular-nums"
            title={service.pid > 0 ? t("taskManager.services.column.pid") : undefined}
          >
            {service.pid > 0 ? service.pid : ""}
          </div>
          <div role="gridcell" className="min-w-0 px-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[service.state])}
                aria-hidden
              />
              <span className="truncate">{t(`taskManager.services.state.${service.state}`)}</span>
            </span>
          </div>
          <div role="gridcell" className="min-w-0 px-2">
            <span
              className={cn(
                "block truncate",
                service.startType === null && "text-muted-foreground",
                service.startType === "manual" && "text-muted-foreground",
                service.startType === "disabled" && "text-destructive"
              )}
            >
              {service.startType === null
                ? "—"
                : t(`taskManager.services.startType.${service.startType}`)}
            </span>
          </div>
          <div role="gridcell" className="min-w-0 px-2">
            <span
              className="text-muted-foreground block truncate"
              title={service.description ?? ""}
            >
              {service.description ?? ""}
            </span>
          </div>
        </div>
      </ContextMenuTrigger>
      <ServiceContextMenuContent service={service} actions={actions} />
    </ContextMenu>
  );
}

export function ServiceTable({
  rows,
  selectedName,
  sort,
  actions,
  onSortChange,
  onSelect,
}: ServiceTableProps) {
  const { t } = useAppTranslation();
  return (
    <div
      role="grid"
      aria-rowcount={rows.length}
      aria-label={t("taskManager.services.title")}
      className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-[900px]">
          <div
            role="row"
            className={cn(
              "text-muted-foreground bg-muted/40 sticky top-0 z-10 grid h-8 items-center border-b text-[11px] font-medium",
              SERVICE_GRID_COLUMNS
            )}
          >
            {COLUMNS.map((column) => (
              <HeaderCell
                key={column.key}
                column={column}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
          </div>
          {rows.map((service) => (
            <ServiceRowView
              key={service.name}
              service={service}
              selected={service.name === selectedName}
              actions={actions}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
