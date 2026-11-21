// The overview tab: the four headline metrics, the mise version panel, the
// environment signals, the recent actions and the full system information. It
// loads once through `useMiseOverview`; the refresh button here reloads the
// dashboard and asks the page shell to probe the runtime again.

import {
  AlertTriangle,
  Boxes,
  ChevronRight,
  ExternalLink,
  FolderTree,
  Monitor,
  Package,
  RefreshCw,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { MiseHealthLevel, MiseHistoryStatus } from "@/commands";
import { HistoryDialog } from "@/components/mise/history-dialog";
import { MetricCard } from "@/components/mise/metric-card";
import { NoticeList } from "@/components/mise/notice-list";
import { StatusBadge } from "@/components/mise/status-badge";
import type { OverviewTabProps } from "@/components/mise/props";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMiseOverview } from "@/hooks/use-mise-overview";
import {
  formatBytes,
  formatRelativeTime,
  historyStatusKey,
  runtimeSourceKey,
  signalKey,
} from "@/lib/mise/format";
import { miseErrorKey } from "@/lib/mise/error-key";
import { navigateApp } from "@/lib/router";

/** A titled card; the overview stacks five of these below the metric row. */
function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-xl border">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-xs break-all select-text">{value}</span>
    </div>
  );
}

const HISTORY_LEVEL: Record<MiseHistoryStatus, MiseHealthLevel> = {
  success: "healthy",
  failure: "critical",
  canceled: "info",
};

export default function OverviewTab({ runtime, onReloadRuntime }: OverviewTabProps) {
  const { t, language } = useAppTranslation();
  const overview = useMiseOverview();
  const [historyOpen, setHistoryOpen] = useState(false);

  const unknown = t("mise.common.unknown");
  const dashboard = overview.dashboard;

  const refresh = () => {
    onReloadRuntime();
    void overview.reload();
  };

  const viewAll = async () => {
    await overview.openHistory();
    setHistoryOpen(true);
  };

  const errorRow = overview.error && (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        {t("mise.error.load")} {t(miseErrorKey(overview.error))}
      </span>
      <Button variant="outline" size="sm" disabled={overview.loading} onClick={refresh}>
        {t("mise.actions.retry")}
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={overview.loading} onClick={refresh}>
          <RefreshCw className={overview.loading ? "animate-spin" : undefined} />
          {t("mise.actions.refresh")}
        </Button>
      </div>

      {errorRow}

      {!dashboard ? (
        overview.loading ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-24 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </>
        ) : (
          overview.error === null && (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm">
              {t("mise.common.empty")}
            </div>
          )
        )
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label={t("mise.overview.metrics.system.label")}
              value={t("mise.overview.metrics.system.caption", {
                os: dashboard.system.osName ?? unknown,
                arch: dashboard.system.arch || unknown,
              })}
              caption={
                [dashboard.system.osVersion, dashboard.system.hostName]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ") || undefined
              }
              level="info"
              icon={Monitor}
            />
            <MetricCard
              label={t("mise.overview.metrics.tools.label")}
              value={String(dashboard.toolSummary.installedToolCount)}
              caption={t("mise.overview.metrics.tools.caption", {
                active: dashboard.toolSummary.activeToolCount,
              })}
              level={dashboard.toolSummary.installedToolCount > 0 ? "healthy" : "info"}
              icon={Package}
            />
            <MetricCard
              label={t("mise.overview.metrics.projects.label")}
              value={
                dashboard.projectSummary.projectCount > 0
                  ? String(dashboard.projectSummary.projectCount)
                  : t("mise.common.notSet")
              }
              caption={t("mise.overview.metrics.projects.caption", {
                overrides: dashboard.projectSummary.overrideBindingCount,
                count: dashboard.projectSummary.projectCount,
              })}
              level={dashboard.projectSummary.projectCount > 0 ? "healthy" : "info"}
              icon={FolderTree}
            />
            <MetricCard
              label={t("mise.overview.metrics.version.label")}
              value={dashboard.versionInfo.version ?? runtime.version ?? unknown}
              caption={t("mise.overview.metrics.version.caption", {
                source: t(runtimeSourceKey(dashboard.versionInfo.source ?? runtime.source ?? null)),
              })}
              level={(dashboard.versionInfo.version ?? runtime.version) ? "healthy" : "warning"}
              icon={Boxes}
            />
          </div>

          <NoticeList notices={dashboard.notices} />

          <Panel title={t("mise.overview.version.title")}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                <InfoRow
                  label={t("mise.overview.version.installed")}
                  value={dashboard.versionInfo.version ?? runtime.version ?? unknown}
                />
                <InfoRow
                  label={t("mise.overview.version.source")}
                  value={t(
                    runtimeSourceKey(dashboard.versionInfo.source ?? runtime.source ?? null)
                  )}
                />
                <div className="sm:col-span-2">
                  <InfoRow
                    label={t("mise.overview.version.executable")}
                    value={
                      dashboard.versionInfo.executable ??
                      runtime.executable ??
                      t("mise.common.notSet")
                    }
                  />
                </div>
              </div>
              <div className="flex max-w-sm flex-col items-start gap-2">
                {(dashboard.versionInfo.source ?? runtime.source) === "scoop" ? (
                  <Button variant="outline" size="sm" onClick={() => navigateApp("/scoop")}>
                    <ExternalLink />
                    {t("mise.overview.version.openScoop")}
                  </Button>
                ) : (
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {t("mise.overview.version.upgradeUnavailable")}
                  </p>
                )}
              </div>
            </div>
          </Panel>

          <Panel title={t("mise.overview.signals.title")}>
            {dashboard.signals.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("mise.overview.signals.empty")}</p>
            ) : (
              <ul className="divide-border flex flex-col divide-y">
                {dashboard.signals.map((signal) => (
                  <li
                    key={signal.code}
                    className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge level={signal.level} />
                        <span className="text-sm font-medium">
                          {t(`${signalKey(signal.code)}.title`)}
                        </span>
                      </div>
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        {t(`${signalKey(signal.code)}.detail`)}
                      </p>
                      {signal.detail && (
                        <p className="text-muted-foreground font-mono text-xs break-all select-text">
                          {signal.detail}
                        </p>
                      )}
                    </div>
                    <span className="max-w-full font-mono text-xs break-all select-text sm:max-w-[50%] sm:text-right">
                      {signal.value}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title={t("mise.overview.history.title")}
            action={
              <Button
                variant="ghost"
                size="sm"
                disabled={overview.historyLoading}
                onClick={() => void viewAll()}
              >
                {t("mise.overview.history.viewAll")}
                <ChevronRight />
              </Button>
            }
          >
            {dashboard.recentHistory.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("mise.overview.history.empty")}</p>
            ) : (
              <ul className="divide-border flex flex-col divide-y">
                {dashboard.recentHistory.slice(0, 3).map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    <StatusBadge
                      level={HISTORY_LEVEL[entry.status]}
                      label={t(historyStatusKey(entry.status))}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <code className="font-mono text-xs break-all select-text">
                        {entry.command}
                      </code>
                      <p className="text-muted-foreground text-xs break-words">{entry.detail}</p>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatRelativeTime(entry.timestampMs, language) || unknown}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={t("mise.overview.system.title")}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <InfoRow
                label={t("mise.overview.system.os")}
                value={dashboard.system.osName ?? unknown}
              />
              <InfoRow
                label={t("mise.overview.system.osVersion")}
                value={dashboard.system.osVersion ?? unknown}
              />
              <InfoRow
                label={t("mise.overview.system.kernel")}
                value={dashboard.system.kernelVersion ?? unknown}
              />
              <InfoRow
                label={t("mise.overview.system.host")}
                value={dashboard.system.hostName ?? unknown}
              />
              <InfoRow
                label={t("mise.overview.system.arch")}
                value={dashboard.system.arch || unknown}
              />
              <InfoRow
                label={t("mise.overview.system.cpu")}
                value={[
                  dashboard.system.cpuBrand,
                  t("mise.overview.system.cpuCount", {
                    count: dashboard.system.cpuCount,
                  }),
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ")}
              />
              <InfoRow
                label={t("mise.overview.system.memory")}
                value={
                  dashboard.system.memoryTotalBytes > 0
                    ? t("mise.overview.system.memoryValue", {
                        available: formatBytes(dashboard.system.memoryAvailableBytes),
                        total: formatBytes(dashboard.system.memoryTotalBytes),
                      })
                    : unknown
                }
              />
              <InfoRow
                label={t("mise.overview.system.disk")}
                value={
                  dashboard.system.diskTotalBytes != null && dashboard.system.diskTotalBytes > 0
                    ? t("mise.overview.system.diskValue", {
                        available: formatBytes(dashboard.system.diskAvailableBytes),
                        total: formatBytes(dashboard.system.diskTotalBytes),
                      })
                    : unknown
                }
              />
              <InfoRow
                label={t("mise.overview.system.diskMount")}
                value={dashboard.system.diskMount ?? unknown}
              />
            </div>
          </Panel>
        </>
      )}

      <HistoryDialog open={historyOpen} entries={overview.history} onOpenChange={setHistoryOpen} />
    </div>
  );
}
