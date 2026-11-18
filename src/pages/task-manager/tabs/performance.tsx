// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The performance tab: five summary cards over the CPU, memory, disk, network
// and GPU panels. The history lives here, so leaving the page clears it and
// coming back rebuilds the window from fresh frames.

import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { argusErrorKey } from "@/commands";
import { PerformanceCpu } from "@/components/task-manager/performance-cpu";
import { PerformanceDisk } from "@/components/task-manager/performance-disk";
import { PerformanceGpu } from "@/components/task-manager/performance-gpu";
import { PerformanceMemory } from "@/components/task-manager/performance-memory";
import { PerformanceNetwork } from "@/components/task-manager/performance-network";
import { PerformanceSummary } from "@/components/task-manager/performance-summary";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import { createHistory, pushHistory } from "@/lib/task-manager/chart-history";
import { SNAPSHOT_SERIES, snapshotMetrics } from "@/lib/task-manager/chart-metrics";

const CARD_SKELETONS = 5;
const PANEL_SKELETONS = 4;

function PerformanceSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" aria-busy="true">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: CARD_SKELETONS }, (_, index) => (
          <div
            key={index}
            className="border-border bg-card flex flex-col gap-2 rounded-xl border p-3"
          >
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-1 w-full" />
            <Skeleton className="h-2 w-24" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        {Array.from({ length: PANEL_SKELETONS }, (_, index) => (
          <div
            key={index}
            className="border-border bg-card flex flex-col gap-3 rounded-xl border p-3"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceEmpty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="border-border bg-card flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-xl border px-6 py-12 text-center">
      <AlertCircle className="text-muted-foreground size-6" />
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="text-muted-foreground max-w-md text-xs">{body}</p>}
    </div>
  );
}

export function PerformanceTab() {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const snapshot = page.snapshot;
  const [history, setHistory] = useState(() => createHistory(SNAPSHOT_SERIES));

  // One bucket per sampled second. The tab stays mounted while the processes
  // tab is shown, so the window keeps filling; leaving the page unmounts it
  // and drops the history with it.
  useEffect(() => {
    if (!snapshot) return;
    const metrics = snapshotMetrics(snapshot);
    setHistory((current) => pushHistory(current, snapshot.timestamp, metrics));
  }, [snapshot]);

  if (!snapshot) {
    if (page.error) {
      return (
        <PerformanceEmpty
          title={t("taskManager.empty.performance")}
          body={t(argusErrorKey(page.error.code))}
        />
      );
    }
    if (page.loading) return <PerformanceSkeleton />;
    return <PerformanceEmpty title={t("taskManager.empty.performance")} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1 pb-1">
      <PerformanceSummary snapshot={snapshot} history={history} />

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        <PerformanceCpu snapshot={snapshot} history={history} />
        <PerformanceMemory snapshot={snapshot} history={history} />
        <PerformanceDisk snapshot={snapshot} history={history} />
        <PerformanceNetwork snapshot={snapshot} history={history} />
        <PerformanceGpu snapshot={snapshot} history={history} />
      </div>
    </div>
  );
}
