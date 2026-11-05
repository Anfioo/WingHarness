import { useEffect, useMemo, useState, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { serverConnectionState, serverMetricsHistory } from "@/commands/services/servers";
import type {
  ConnectionState,
  MetricsSample,
  ServerMetricsEvent,
} from "@/commands/services/servers/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes, formatPercent, formatRate, formatUptime } from "@/lib/servers/format";
import { cn } from "@/lib/utils";
import { MetricChart, type MetricPoint } from "./metrics-chart";

/** Mirrors `server_core::events`. */
const METRICS_EVENT = "server:metrics";
/** Two minutes of samples are enough for the charts. */
const MAX_POINTS = 120;
/** The engine has no state event, so the tab watches the state directly. */
const STATE_POLL_MS = 2000;

const CPU_COLOR = "#3b82f6";
const MEMORY_COLOR = "#8b5cf6";
const DISK_READ_COLOR = "#f59e0b";
const DISK_WRITE_COLOR = "#ef4444";
const NETWORK_DOWN_COLOR = "#0ea5e9";
const NETWORK_UP_COLOR = "#10b981";

/**
 * Live metrics of one profile: cards, system details and four line charts.
 *
 * Samples arrive every second whether or not this tab is visible; `history`
 * fills the charts with whatever the engine collected before the tab opened.
 */
export function MetricsTab({ profileId }: { profileId: string }) {
  const { t, language } = useAppTranslation();
  const [samples, setSamples] = useState<MetricsSample[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSamples([]);
    setConnectionState(null);

    void (async () => {
      try {
        const [state, history] = await Promise.all([
          serverConnectionState(profileId),
          serverMetricsHistory(profileId),
        ]);
        if (cancelled) return;
        setConnectionState(state);
        setSamples(history.slice(-MAX_POINTS));
      } catch (error) {
        console.error("Failed to load server metrics:", error);
      }
    })();

    let unlisten: UnlistenFn | undefined;
    void listen<ServerMetricsEvent>(METRICS_EVENT, (event) => {
      if (event.payload.profileId !== profileId) return;
      setSamples((current) => {
        const last = current.length > 0 ? current[current.length - 1] : null;
        // The history call and the listener race by a few milliseconds; drop a
        // sample that is already in the buffer instead of drawing it twice.
        if (last !== null && event.payload.sample.at <= last.at) return current;
        return [...current, event.payload.sample].slice(-MAX_POINTS);
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const state = await serverConnectionState(profileId);
          if (cancelled) return;
          setConnectionState(state);
          // The engine drops the buffer with the connection; a reconnect must
          // not mix old samples into the new curve.
          if (state === "idle") {
            setSamples((current) => (current.length === 0 ? current : []));
          }
        } catch (error) {
          console.error("Failed to read the server connection state:", error);
        }
      })();
    }, STATE_POLL_MS);

    return () => {
      cancelled = true;
      unlisten?.();
      window.clearInterval(poll);
    };
  }, [profileId]);

  const cpuPoints = useMemo<MetricPoint[]>(
    () =>
      samples.map((sample) => ({ at: sample.at * 1000, values: { overall: sample.cpu.overall } })),
    [samples]
  );
  const memoryPoints = useMemo<MetricPoint[]>(
    () =>
      samples.map((sample) => ({
        at: sample.at * 1000,
        values: { percent: sample.memory.percent },
      })),
    [samples]
  );
  const diskPoints = useMemo<MetricPoint[]>(
    () =>
      samples.map((sample) => ({
        at: sample.at * 1000,
        values: {
          read: sample.disk.readBytesPerSec,
          write: sample.disk.writeBytesPerSec,
        },
      })),
    [samples]
  );
  const networkPoints = useMemo<MetricPoint[]>(
    () =>
      samples.map((sample) => ({
        at: sample.at * 1000,
        values: {
          rx: sample.network.rxBytesPerSec,
          tx: sample.network.txBytesPerSec,
        },
      })),
    [samples]
  );

  if (connectionState === "idle") {
    return <Notice text={t("servers.metrics.notConnected")} />;
  }
  if (connectionState === "connecting") {
    return <Notice text={t("servers.metrics.connecting")} />;
  }

  const sample = samples.length > 0 ? samples[samples.length - 1] : null;
  if (sample === null) {
    return <Notice text={t("servers.metrics.waiting")} />;
  }

  const waiting = { waiting: t("servers.metrics.waiting") };

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">
        <Card label={t("servers.metrics.latency")}>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {sample.latencyMs.toFixed(1)} ms
          </span>
        </Card>
        <Card
          label={t("servers.metrics.cpu")}
          hint={`${t("servers.metrics.user")} ${formatPercent(sample.cpu.user)} / ${t("servers.metrics.system")} ${formatPercent(sample.cpu.system)}`}
        >
          {formatPercent(sample.cpu.overall)}
        </Card>
        <Card
          label={t("servers.metrics.memory")}
          hint={formatPercent(sample.memory.percent)}
          size="sm"
        >
          {formatBytes(sample.memory.used, language)} / {formatBytes(sample.memory.total, language)}
        </Card>
        <Card
          label={t("servers.metrics.disk")}
          hint={`${formatBytes(sample.disk.used, language)} / ${formatBytes(sample.disk.total, language)}`}
        >
          {formatPercent(sample.disk.percent)}
        </Card>
        <Card label={t("servers.metrics.network")}>
          <span className="flex flex-col text-sm leading-tight">
            <span>↓ {formatRate(sample.network.rxBytesPerSec, language)}</span>
            <span>↑ {formatRate(sample.network.txBytesPerSec, language)}</span>
          </span>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        <Detail
          label={t("servers.metrics.load")}
          value={`${sample.load.one.toFixed(2)} ${sample.load.five.toFixed(2)} ${sample.load.fifteen.toFixed(2)}`}
        />
        <Detail label={t("servers.metrics.uptime")} value={formatUptime(sample.uptimeSecs)} />
        <Detail label={t("servers.metrics.processes")} value={String(sample.processes)} />
        <Detail label={t("servers.metrics.threads")} value={String(sample.threads)} />
        <Detail
          label={t("servers.metrics.availableMemory")}
          value={formatBytes(sample.memory.available, language)}
        />
        <Detail
          label={t("servers.metrics.swap")}
          value={
            sample.memory.swapTotal > 0
              ? `${formatBytes(sample.memory.swapUsed, language)} / ${formatBytes(sample.memory.swapTotal, language)}`
              : "—"
          }
        />
        <Detail
          label={t("servers.metrics.diskIo")}
          value={`↓ ${formatRate(sample.disk.readBytesPerSec, language)} · ↑ ${formatRate(sample.disk.writeBytesPerSec, language)}`}
        />
        <Detail label={t("servers.metrics.iowait")} value={formatPercent(sample.cpu.iowait)} />
        <Detail label={t("servers.metrics.steal")} value={formatPercent(sample.cpu.steal)} />
        <Detail
          label={t("servers.metrics.inodeUsage")}
          value={formatPercent(sample.disk.inodePercent)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <ChartSection title={t("servers.metrics.cpuChart")}>
          <MetricChart
            points={cpuPoints}
            series={[{ key: "overall", label: t("servers.metrics.cpu"), color: CPU_COLOR }]}
            maxValue={100}
            formatValue={formatPercent}
            labels={waiting}
          />
        </ChartSection>
        <ChartSection title={t("servers.metrics.memoryChart")}>
          <MetricChart
            points={memoryPoints}
            series={[{ key: "percent", label: t("servers.metrics.memory"), color: MEMORY_COLOR }]}
            maxValue={100}
            formatValue={formatPercent}
            labels={waiting}
          />
        </ChartSection>
        <ChartSection title={t("servers.metrics.diskChart")}>
          <MetricChart
            points={diskPoints}
            series={[
              { key: "read", label: t("servers.metrics.read"), color: DISK_READ_COLOR },
              { key: "write", label: t("servers.metrics.write"), color: DISK_WRITE_COLOR },
            ]}
            formatValue={(value) => formatRate(value, language)}
            labels={waiting}
          />
        </ChartSection>
        <ChartSection title={t("servers.metrics.networkChart")}>
          <MetricChart
            points={networkPoints}
            series={[
              { key: "rx", label: t("servers.metrics.download"), color: NETWORK_DOWN_COLOR },
              { key: "tx", label: t("servers.metrics.upload"), color: NETWORK_UP_COLOR },
            ]}
            formatValue={(value) => formatRate(value, language)}
            labels={waiting}
          />
        </ChartSection>
      </div>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
      {text}
    </div>
  );
}

function Card({
  label,
  hint,
  size = "lg",
  children,
}: {
  label: string;
  hint?: string;
  size?: "lg" | "sm";
  children: ReactNode;
}) {
  return (
    <div className="bg-card min-w-0 rounded-md border px-2.5 py-2">
      <div className="text-muted-foreground text-[11px]">{label}</div>
      <div
        className={cn(
          "text-foreground mt-0.5 truncate font-semibold tabular-nums",
          size === "lg" ? "text-lg leading-tight" : "text-sm leading-tight"
        )}
      >
        {children}
      </div>
      {hint !== undefined && (
        <div className="text-muted-foreground truncate text-[11px] tabular-nums">{hint}</div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/30 flex min-w-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5">
      <span className="text-muted-foreground shrink-0 text-[11px]">{label}</span>
      <span className="truncate font-mono text-[11px] tabular-nums">{value}</span>
    </div>
  );
}

function ChartSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-1.5">
      <h3 className="text-xs font-medium">{title}</h3>
      {children}
    </section>
  );
}
