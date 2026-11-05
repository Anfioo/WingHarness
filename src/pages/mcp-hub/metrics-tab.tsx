import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Loader2, Radio, Timer } from "lucide-react";
import { toast } from "sonner";
import { mcphubMetrics, type MetricsView } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Badge } from "./ui-bits";

function formatUptimeHms(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function formatAgo(ts?: number): string {
  if (!ts) return "—";
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function GlobalCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="border-border bg-muted/30 flex flex-col gap-1.5 rounded-lg border p-4">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {icon}
        {label}
      </div>
      <div className="font-mono text-2xl font-semibold">{value}</div>
    </div>
  );
}

export function MetricsTab() {
  const { t } = useAppTranslation();
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await mcphubMetrics();
      setMetrics(data);
    } catch (error) {
      console.error("mcphub metrics:", error);
      toast.error(t("mcphub.metrics.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    timerRef.current = window.setInterval(() => void load(), 5000);
    return () => {
      if (timerRef.current != null) window.clearInterval(timerRef.current);
    };
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t("mcphub.loading")}
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="border-border/60 rounded-lg border border-dashed p-8 text-center text-sm">
        <p className="text-muted-foreground">{t("mcphub.metrics.empty")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Global metrics */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <GlobalCard
          icon={<Activity className="size-3.5" />}
          label={t("mcphub.metrics.totalRequests")}
          value={String(metrics.totalRequests)}
        />
        <GlobalCard
          icon={<Radio className="size-3.5" />}
          label={t("mcphub.metrics.activeSessions")}
          value={String(metrics.activeSessions)}
        />
        <GlobalCard
          icon={<Timer className="size-3.5" />}
          label={t("mcphub.metrics.uptime")}
          value={formatUptimeHms(metrics.uptimeSecs)}
        />
      </div>

      {/* Per-server metrics */}
      {metrics.servers.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center text-sm">
          <p className="text-muted-foreground">{t("mcphub.metrics.noServers")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {metrics.servers.map((s) => (
            <div key={s.name} className="border-border flex flex-col gap-2.5 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-medium">{s.name}</span>
                <div className="flex gap-1">
                  {s.running && (
                    <Badge tone={s.healthy ? "green" : "amber"}>
                      {s.healthy ? t("mcphub.metrics.healthy") : t("mcphub.metrics.unhealthy")}
                    </Badge>
                  )}
                  <Badge tone={s.running ? "green" : "gray"}>
                    {s.running ? t("mcphub.metrics.running") : t("mcphub.metrics.stopped")}
                  </Badge>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">
                    {t("mcphub.metrics.requests")}
                  </span>
                  <span className="font-mono text-sm font-medium">{s.requests}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">
                    {t("mcphub.metrics.errors")}
                  </span>
                  <span className="font-mono text-sm font-medium">{s.errors}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-muted-foreground text-xs">
                    {t("mcphub.metrics.avgLatency")}
                  </span>
                  <span className="font-mono text-sm font-medium">
                    {s.avgLatencyMs != null ? `${s.avgLatencyMs} ms` : "—"}
                  </span>
                </div>
              </div>
              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <span>{t("mcphub.metrics.lastCall")}</span>
                <span className="font-mono">{formatAgo(s.lastCallAt ?? undefined)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
