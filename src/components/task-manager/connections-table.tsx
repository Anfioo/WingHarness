// The connections table: one row per endpoint, sorted by a column header and
// carrying the per-row context menu.

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Connection, ProcessRow } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { connectionEndpoint, connectionKey } from "@/hooks/use-task-manager-connections";
import { processLabel } from "@/lib/task-manager/process-identity";
import { cn } from "@/lib/utils";
import { ConnectionsContextMenu } from "./connections-context-menu";
import { ConnectionsStatus } from "./connections-status";
import { ProcessIcon } from "./process-icon";

export type ConnectionSortKey = "process" | "protocol" | "local" | "remote" | "state" | "pid";

type ConnectionSort = { key: ConnectionSortKey; desc: boolean };

const DEFAULT_SORT: ConnectionSort = { key: "local", desc: false };

const GRID =
  "grid-cols-[minmax(180px,1.4fr)_86px_minmax(150px,1.1fr)_minmax(150px,1.1fr)_110px_76px]";

function sortValue(
  connection: Connection,
  key: ConnectionSortKey,
  processes: ReadonlyMap<number, ProcessRow>
): string | number {
  const process = processes.get(connection.pid);
  switch (key) {
    case "process":
      return (process ? processLabel(process) : "").toLocaleLowerCase();
    case "protocol":
      return `${connection.protocol}${connection.ipv6 ? 6 : 4}`;
    case "local":
      return connection.localPort;
    case "remote":
      return connection.remotePort ?? -1;
    case "state":
      return connection.state ?? "";
    case "pid":
      return connection.pid;
  }
}

export function ConnectionsTable({
  rows,
  processes,
  serviceReady,
  onReveal,
  onKill,
  onClose,
}: {
  rows: Connection[];
  processes: ReadonlyMap<number, ProcessRow>;
  serviceReady: boolean;
  onReveal: (connection: Connection) => void;
  onKill: (connection: Connection, process: ProcessRow) => void;
  onClose: (connection: Connection) => void;
}) {
  const { t } = useAppTranslation();
  const [sort, setSort] = useState<ConnectionSort>(DEFAULT_SORT);

  const sorted = useMemo(() => {
    const direction = sort.desc ? -1 : 1;
    return [...rows].sort((left, right) => {
      const a = sortValue(left, sort.key, processes);
      const b = sortValue(right, sort.key, processes);
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      return String(a).localeCompare(String(b), undefined, { numeric: true }) * direction;
    });
  }, [rows, processes, sort]);

  const columns: { key: ConnectionSortKey; label: string; align?: "end" }[] = [
    { key: "process", label: t("taskManager.connections.column.process") },
    { key: "protocol", label: t("taskManager.connections.column.protocol") },
    { key: "local", label: t("taskManager.connections.column.local") },
    { key: "remote", label: t("taskManager.connections.column.remote") },
    { key: "state", label: t("taskManager.connections.column.state") },
    { key: "pid", label: t("taskManager.connections.column.pid"), align: "end" },
  ];

  const toggleSort = (key: ConnectionSortKey) => {
    setSort((current) =>
      current.key === key ? { key, desc: !current.desc } : { key, desc: false }
    );
  };

  return (
    <div className="border-border bg-card min-h-0 flex-1 overflow-auto rounded-xl border">
      <div className="min-w-[860px]">
        <div
          className={cn(
            "bg-muted text-muted-foreground sticky top-0 z-10 grid items-center gap-2 border-b px-3 py-2 text-xs font-medium",
            GRID
          )}
        >
          {columns.map((column) => (
            <button
              key={column.key}
              type="button"
              onClick={() => toggleSort(column.key)}
              className={cn(
                "flex items-center gap-1 text-left",
                column.align === "end" && "justify-end",
                sort.key === column.key && "text-foreground"
              )}
            >
              {column.label}
              {sort.key === column.key &&
                (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
            </button>
          ))}
        </div>

        {sorted.map((connection) => {
          const process = processes.get(connection.pid);
          const local = connectionEndpoint(
            connection.localAddress,
            connection.localPort,
            connection.ipv6
          );
          const remote =
            connection.remoteAddress === null
              ? "—"
              : connectionEndpoint(
                  connection.remoteAddress,
                  connection.remotePort,
                  connection.ipv6
                );
          return (
            <ConnectionsContextMenu
              key={connectionKey(connection)}
              connection={connection}
              process={process}
              serviceReady={serviceReady}
              onReveal={onReveal}
              onKill={onKill}
              onClose={onClose}
            >
              <div
                className={cn(
                  "border-border/60 hover:bg-muted/40 grid items-center gap-2 border-b px-3 py-1.5 text-xs",
                  GRID
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {process ? (
                    <ProcessIcon process={process} size={16} />
                  ) : (
                    <span className="bg-muted size-4 shrink-0 rounded" aria-hidden />
                  )}
                  <span className="truncate" title={process ? processLabel(process) : undefined}>
                    {process ? processLabel(process) : `PID ${connection.pid}`}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span>{t(`taskManager.connections.protocol.${connection.protocol}`)}</span>
                  {connection.ipv6 && (
                    <Badge variant="secondary" className="px-1 py-0 text-[10px] font-normal">
                      {t("taskManager.connections.protocol.ipv6")}
                    </Badge>
                  )}
                </div>
                <span className="truncate font-mono" title={local}>
                  {local}
                </span>
                <span
                  className={cn(
                    "truncate font-mono",
                    connection.remoteAddress === null && "text-muted-foreground"
                  )}
                  title={remote}
                >
                  {remote}
                </span>
                <ConnectionsStatus state={connection.state} />
                <span className="text-muted-foreground text-right font-mono">{connection.pid}</span>
              </div>
            </ConnectionsContextMenu>
          );
        })}
      </div>
    </div>
  );
}
