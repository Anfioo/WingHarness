// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The processes that stood out in one recorded frame. Sorting starts on CPU,
// busiest first; a row names a process that may have exited since, so the
// action only reveals the live process when it still exists.

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight } from "lucide-react";
import type { HistoryProcess, ProcessRow } from "@/commands";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { formatBytes, formatPercent, formatRate } from "./format";
import { ProcessIcon } from "./process-icon";

type SortKey = "name" | "pid" | "cpu" | "mem" | "io" | "gpu" | "net";

type Sort = { key: SortKey; desc: boolean };

const DEFAULT_SORT: Sort = { key: "cpu", desc: true };

const BASE_GRID = "grid-cols-[minmax(160px,1fr)_72px_64px_88px_84px_64px]";
const NET_GRID = "grid-cols-[minmax(160px,1fr)_72px_64px_88px_84px_64px_88px]";

const LABEL_KEYS: Record<SortKey, string> = {
  name: "taskManager.history.process.column.name",
  pid: "taskManager.history.process.column.pid",
  cpu: "taskManager.history.process.column.cpu",
  mem: "taskManager.history.process.column.mem",
  io: "taskManager.history.process.column.io",
  gpu: "taskManager.history.process.column.gpu",
  net: "taskManager.history.process.column.net",
};

function sortValue(process: HistoryProcess, key: SortKey): string | number {
  switch (key) {
    case "name":
      return process.name.toLocaleLowerCase();
    case "pid":
      return process.pid;
    case "cpu":
      return process.cpu;
    case "mem":
      return process.mem;
    case "io":
      return process.io;
    case "gpu":
      return process.gpu;
    case "net":
      return process.net;
  }
}

export function HistoryProcessTable({
  rows,
  liveByPid,
  liveByName,
  onActivate,
  empty,
}: {
  rows: readonly HistoryProcess[];
  liveByPid: ReadonlyMap<number, ProcessRow>;
  liveByName: ReadonlyMap<string, ProcessRow>;
  onActivate: (process: HistoryProcess) => void;
  empty: string;
}) {
  const { t } = useAppTranslation();
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

  // Per-process network needs administrator rights; without them every row
  // would show zero, so the column only appears when something was measured.
  const showNet = rows.some((process) => process.net > 0);
  const keys: readonly SortKey[] = showNet
    ? ["name", "pid", "cpu", "mem", "io", "gpu", "net"]
    : ["name", "pid", "cpu", "mem", "io", "gpu"];
  const grid = showNet ? NET_GRID : BASE_GRID;

  const sorted = useMemo(() => {
    const direction = sort.desc ? -1 : 1;
    return [...rows].sort((left, right) => {
      const a = sortValue(left, sort.key);
      const b = sortValue(right, sort.key);
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      return String(a).localeCompare(String(b), undefined, { numeric: true }) * direction;
    });
  }, [rows, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((current) =>
      current.key === key ? { key, desc: !current.desc } : { key, desc: false }
    );
  };

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground border-border rounded-lg border border-dashed px-3 py-6 text-center text-xs">
        {empty}
      </p>
    );
  }

  return (
    <div className="border-border bg-card overflow-x-auto rounded-xl border">
      <div className="min-w-[720px]">
        <div
          className={cn(
            "bg-muted text-muted-foreground sticky top-0 z-10 grid items-center gap-2 border-b px-3 py-2 text-xs font-medium",
            grid
          )}
        >
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => toggleSort(key)}
              className={cn(
                "flex items-center gap-1 text-left",
                key !== "name" && "justify-end",
                sort.key === key && "text-foreground"
              )}
            >
              {t(LABEL_KEYS[key])}
              {sort.key === key &&
                (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
            </button>
          ))}
        </div>

        {sorted.map((process) => {
          const live = liveByName.get(process.name.toLocaleLowerCase());
          const running = liveByPid.get(process.pid)?.name === process.name;
          return (
            <ContextMenu key={`${process.name}:${process.pid}`}>
              <ContextMenuTrigger asChild>
                <div
                  role="row"
                  tabIndex={0}
                  onClick={() => onActivate(process)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onActivate(process);
                  }}
                  className={cn(
                    "border-border/60 hover:bg-muted/40 grid h-8 cursor-default items-center gap-2 border-b px-3 text-xs",
                    grid
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ProcessIcon
                      process={{ icon: live?.icon ?? null, path: live?.path ?? "" }}
                      size={16}
                    />
                    <span className="truncate" title={live?.description ?? undefined}>
                      {process.name}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-right font-mono">{process.pid}</span>
                  <span className="text-right tabular-nums">{formatPercent(process.cpu, 0)}</span>
                  <span className="text-right tabular-nums">{formatBytes(process.mem)}</span>
                  <span className="text-right tabular-nums">{formatRate(process.io, 0)}</span>
                  <span className="text-right tabular-nums">{formatPercent(process.gpu, 0)}</span>
                  {showNet && (
                    <span className="text-right tabular-nums">{formatRate(process.net, 0)}</span>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-56">
                <ContextMenuItem disabled={!running} onSelect={() => onActivate(process)}>
                  <ArrowUpRight />
                  {t("taskManager.history.actions.gotoProcess")}
                </ContextMenuItem>
                {!running && (
                  <ContextMenuLabel className="text-muted-foreground text-xs font-normal">
                    {t("taskManager.history.process.exited")}
                  </ContextMenuLabel>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </div>
  );
}
