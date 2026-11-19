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
import {
  performanceDeviceKey,
  subscribePerformanceTarget,
  takePerformanceTarget,
} from "@/lib/task-manager/performance-target";

const LIST_SKELETONS = 6;

function PerformanceSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row" aria-busy="true">
      <div className="border-border bg-card flex shrink-0 flex-col gap-2 rounded-lg border p-2 lg:w-[248px]">
        {Array.from({ length: LIST_SKELETONS }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-1 py-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2.5 w-14" />
            </div>
            <Skeleton className="h-10 w-[76px]" />
          </div>
        ))}
      </div>
      <div className="border-border bg-card flex min-h-0 flex-1 flex-col gap-3 rounded-lg border p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="min-h-60 w-full flex-1" />
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
    <div className="border-border bg-card flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-lg border px-6 py-12 text-center">
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
  const intervalMs = page.settings.intervalMs;
  const [history, setHistory] = useState(() => createHistory(SNAPSHOT_SERIES));
  const [selected, setSelected] = useState("cpu");

  // A vitals card on the processes tab names the device to open. That tab
  // switches here itself; this one is kept mounted, so the request usually
  // arrives through the subscription, and the pending one covers a first mount.
  useEffect(() => {
    const apply = (target: string) => setSelected(performanceDeviceKey(target));
    const pendingTarget = takePerformanceTarget();
    if (pendingTarget) apply(pendingTarget);
    return subscribePerformanceTarget(apply);
  }, []);

  // One point per sample, so the curve is continuous whatever the interval.
  // The tab stays mounted while the processes tab is shown, so the window
  // keeps filling; leaving the page unmounts it and drops the history with it.
  useEffect(() => {
    if (!snapshot) return;
    const metrics = snapshotMetrics(snapshot);
    setHistory((current) => pushHistory(current, metrics));
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
      <aside className="border-border bg-card flex max-h-[45%] min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-lg border p-2 lg:max-h-none lg:w-[248px]">
        <PerformanceDeviceList
          devices={devices}
          selected={currentKey}
          history={history}
          onSelect={setSelected}
        />
      </aside>

      <section className="border-border bg-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 lg:px-5">
          {!current ? (
            <PerformanceEmpty title={t("taskManager.empty.performance")} />
          ) : current.kind === "cpu" ? (
            <PerformanceCpu snapshot={snapshot} history={history} intervalMs={intervalMs} />
          ) : current.kind === "memory" ? (
            <PerformanceMemory snapshot={snapshot} history={history} intervalMs={intervalMs} />
          ) : current.kind === "disk" ? (
            <PerformanceDisk
              snapshot={snapshot}
              history={history}
              intervalMs={intervalMs}
              index={current.index ?? 0}
            />
          ) : current.kind === "nic" ? (
            <PerformanceNetwork
              snapshot={snapshot}
              history={history}
              intervalMs={intervalMs}
              id={current.id ?? ""}
            />
          ) : current.kind === "gpu" ? (
            <PerformanceGpu
              snapshot={snapshot}
              history={history}
              intervalMs={intervalMs}
              id={current.id ?? ""}
            />
          ) : (
            <PerformanceBattery
              snapshot={snapshot}
              history={history}
              intervalMs={intervalMs}
              id={current.id ?? ""}
            />
          )}
        </div>
      </section>
    </div>
  );
}
