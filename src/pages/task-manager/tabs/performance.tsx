// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The performance tab: a device list on the left (CPU, memory, every disk,
// adapter, GPU and battery) and that device's detail view on the right. The
// rolling window lives here, so leaving the page clears it.

import { useEffect, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { argusErrorKey } from "@/commands";
import { PerformanceBattery } from "@/components/task-manager/performance-battery";
import { PerformanceCpu } from "@/components/task-manager/performance-cpu";
import {
  PerformanceDeviceList,
  buildPerformanceDevices,
} from "@/components/task-manager/performance-devices";
import { PerformanceDisk } from "@/components/task-manager/performance-disk";
import { PerformanceGpu } from "@/components/task-manager/performance-gpu";
import { PerformanceMemory } from "@/components/task-manager/performance-memory";
import { PerformanceNetwork } from "@/components/task-manager/performance-network";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import { createHistory, pushHistory } from "@/lib/task-manager/chart-history";
import { SNAPSHOT_SERIES, snapshotMetrics } from "@/lib/task-manager/chart-metrics";

const LIST_SKELETONS = 6;

function PerformanceSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row" aria-busy="true">
      <div className="border-border bg-card flex shrink-0 flex-col gap-2 rounded-xl border p-2 lg:w-60">
        {Array.from({ length: LIST_SKELETONS }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-1 py-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2.5 w-14" />
            </div>
            <Skeleton className="h-6 w-14" />
          </div>
        ))}
      </div>
      <div className="border-border bg-card flex min-h-0 flex-1 flex-col gap-3 rounded-xl border p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-40 w-full" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
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
  const [selected, setSelected] = useState("cpu");

  // One bucket per sampled second. The tab stays mounted while the processes
  // tab is shown, so the window keeps filling; leaving the page unmounts it
  // and drops the history with it.
  useEffect(() => {
    if (!snapshot) return;
    const metrics = snapshotMetrics(snapshot);
    setHistory((current) => pushHistory(current, snapshot.timestamp, metrics));
  }, [snapshot]);

  const devices = useMemo(
    () => (snapshot ? buildPerformanceDevices(snapshot, history, t) : []),
    [snapshot, history, t]
  );

  const currentKey = devices.some((device) => device.key === selected)
    ? selected
    : (devices[0]?.key ?? "cpu");
  const current = devices.find((device) => device.key === currentKey) ?? null;

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
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      <aside className="border-border bg-card w-full shrink-0 overflow-y-auto rounded-xl border p-2 lg:w-60">
        <PerformanceDeviceList
          devices={devices}
          selected={currentKey}
          history={history}
          onSelect={setSelected}
        />
      </aside>

      <section className="border-border bg-card min-w-0 flex-1 overflow-y-auto rounded-xl border p-4">
        {!current ? (
          <PerformanceEmpty title={t("taskManager.empty.performance")} />
        ) : current.kind === "cpu" ? (
          <PerformanceCpu snapshot={snapshot} history={history} />
        ) : current.kind === "memory" ? (
          <PerformanceMemory snapshot={snapshot} history={history} />
        ) : current.kind === "disk" ? (
          <PerformanceDisk snapshot={snapshot} history={history} index={current.index ?? 0} />
        ) : current.kind === "nic" ? (
          <PerformanceNetwork snapshot={snapshot} history={history} id={current.id ?? ""} />
        ) : current.kind === "gpu" ? (
          <PerformanceGpu snapshot={snapshot} history={history} id={current.id ?? ""} />
        ) : (
          <PerformanceBattery snapshot={snapshot} history={history} id={current.id ?? ""} />
        )}
      </section>
    </div>
  );
}
