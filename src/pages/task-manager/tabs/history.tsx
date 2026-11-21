// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The history tab: four time ranges, one chart per system resource on a shared
// clock, a cursor that reads a moment and pins it, and the processes that stood
// out at that moment.

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { HistoryProcess, ProcessRow } from "@/commands";
import {
  HistoryAxis,
  HistoryChart,
  HISTORY_AXIS_HEIGHT,
  HISTORY_CHART_HEIGHT,
} from "@/components/task-manager/history-chart";
import { HistoryProcessTable } from "@/components/task-manager/history-process-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import { useTaskManagerHistory } from "@/hooks/use-task-manager-history";
import { createHistoryTimeFormat } from "@/lib/task-manager/history-format";
import { createHistoryMetrics, visibleHistoryMetrics } from "@/lib/task-manager/history-metrics";
import {
  chartTicks,
  HISTORY_RANGES,
  nearest,
  pointAt,
  type HistoryRangeId,
} from "@/lib/task-manager/history-range";
import { openSettingsSection } from "@/lib/window";
import { cn } from "@/lib/utils";

const RANGE_LABELS: Record<HistoryRangeId, string> = {
  "1h": "taskManager.history.range.hour1",
  "6h": "taskManager.history.range.hour6",
  "24h": "taskManager.history.range.hour24",
  "7d": "taskManager.history.range.day7",
};

export function HistoryTab() {
  const { t, language } = useAppTranslation();
  const page = useTaskManager();
  const { revealProcess } = page;
  const active = page.activeTab === "history";
  const history = useTaskManagerHistory(active);
  const time = useMemo(() => createHistoryTimeFormat(language), [language]);
  const metrics = useMemo(() => createHistoryMetrics(t), [t]);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const view = history.view;
  const currentMetrics = useMemo(
    () => visibleHistoryMetrics(metrics, view.points),
    [metrics, view.points]
  );
  const ticks = useMemo(
    () => chartTicks(view.from, view.to, history.range.tickMs),
    [view.from, view.to, history.range.tickMs]
  );
  const maxima = useMemo(() => {
    const map = new Map<string, number>();
    for (const metric of currentMetrics)
      map.set(metric.id, Math.max(1e-9, metric.max(view.points)));
    return map;
  }, [currentMetrics, view.points]);

  // What the cursor reads: the hovered moment, else the pinned one, else the newest point.
  const cursorTs = hoverTs ?? history.pinnedTs;
  const cursorPoint = useMemo(() => {
    if (cursorTs === null) return null;
    const index = pointAt(view.ts, view.joined, view.step, cursorTs);
    return index === undefined ? null : view.points[index];
  }, [cursorTs, view]);
  const readout = cursorTs === null ? (view.points.at(-1) ?? null) : cursorPoint;

  // A pinned moment keeps its line while the pointer reads another one; both
  // are clamped to the plot, and only the reading one carries the time label.
  const span = Math.max(1, view.to - view.from);
  const fractionOf = (ts: number | null): number | null => {
    if (ts === null) return null;
    const fraction = (ts - view.from) / span;
    return fraction >= 0 && fraction <= 1 ? fraction : null;
  };
  const pinnedFraction = fractionOf(history.pinnedTs);
  const hoverFraction = fractionOf(hoverTs);
  const activeFraction = hoverFraction ?? pinnedFraction;
  const labelFraction =
    activeFraction === null ? null : Math.min(0.95, Math.max(0.05, activeFraction));
  const activeTs = hoverFraction !== null ? hoverTs : history.pinnedTs;

  // Live processes: the icon of a program still running, and whether a row can
  // be revealed. Only the page's existing snapshot is read; the tab never polls.
  const live = useMemo(() => {
    const byPid = new Map<number, ProcessRow>();
    const byName = new Map<string, ProcessRow>();
    for (const process of page.snapshot?.processes ?? []) {
      byPid.set(process.pid, process);
      const name = process.name.toLocaleLowerCase();
      if (!byName.has(name)) byName.set(name, process);
    }
    return { byPid, byName };
  }, [page.snapshot]);

  const activate = useCallback(
    (process: HistoryProcess) => {
      if (live.byPid.get(process.pid)?.name === process.name) {
        revealProcess(process.pid);
      } else {
        toast.error(t("taskManager.history.process.exited"));
      }
    },
    [live, revealProcess, t]
  );

  const timeAt = (event: { clientX: number }): number | null => {
    const plot = plotRef.current;
    if (!plot) return null;
    const rect = plot.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const fraction = (event.clientX - rect.left) / rect.width;
    if (!(fraction >= 0 && fraction <= 1)) return null;
    return Math.round(view.from + fraction * (view.to - view.from));
  };

  const move = (by: number) => {
    if (view.points.length === 0) return;
    const at = nearest(view.ts, history.pinnedTs ?? view.points[view.points.length - 1].ts);
    const next = view.points[Math.min(view.points.length - 1, Math.max(0, at + by))];
    history.setPinned(next.ts);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = view.points.length;
    const far = Math.max(1, Math.round(count / 10));
    switch (event.key) {
      case "ArrowLeft":
        move(event.shiftKey ? -far : -1);
        break;
      case "ArrowRight":
        move(event.shiftKey ? far : 1);
        break;
      case "PageUp":
        move(-far);
        break;
      case "PageDown":
        move(far);
        break;
      case "Home":
        if (count > 0) history.setPinned(view.points[0].ts);
        break;
      case "End":
        if (count > 0) history.setPinned(view.points[count - 1].ts);
        break;
      case "Escape":
        history.backToLatest();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const hasPoints = view.points.length > 0;
  const showLoading = !history.loaded || (history.loading && !hasPoints);
  const emptyKind: "off" | "none" | "error" | null =
    !showLoading && !hasPoints
      ? history.recordingOff
        ? "off"
        : history.error
          ? "error"
          : "none"
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t("taskManager.history.title")}
          className="bg-muted/70 flex items-center gap-0.5 rounded-lg p-0.5"
        >
          {HISTORY_RANGES.map((range) => (
            <button
              key={range.id}
              type="button"
              aria-pressed={range.id === history.rangeId}
              onClick={() => history.chooseRange(range.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                range.id === history.rangeId
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(RANGE_LABELS[range.id])}
            </button>
          ))}
        </div>

        {!history.following && (
          <Button variant="outline" size="sm" onClick={history.backToLatest}>
            {t("taskManager.history.latest")}
          </Button>
        )}

        {history.recordingOff && (
          <span className="text-muted-foreground text-xs">
            {t("taskManager.history.empty.disabled")}
          </span>
        )}

        <Button
          variant="outline"
          size="icon"
          className="ml-auto"
          onClick={history.refresh}
          aria-label={t("taskManager.history.actions.refresh")}
        >
          <RefreshCw className={cn("size-4", history.loading && "animate-spin")} />
        </Button>
      </div>

      {history.error && hasPoints && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {t("taskManager.history.empty.error")}
        </div>
      )}

      <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-auto rounded-xl border p-3">
        {showLoading ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t("taskManager.history.chart.loading")}</span>
            <Skeleton className="h-[420px] w-full" />
          </div>
        ) : emptyKind !== null ? (
          <div className="flex min-h-[320px] flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            {emptyKind === "off" && (
              <>
                <p className="text-sm font-medium">{t("taskManager.history.empty.disabled")}</p>
                <p className="text-muted-foreground max-w-sm text-xs">
                  {t("taskManager.history.empty.disabledHint")}
                </p>
                <Button size="sm" onClick={() => void openSettingsSection("taskManager")}>
                  {t("taskManager.history.actions.enable")}
                </Button>
              </>
            )}
            {emptyKind === "none" && (
              <p className="text-sm font-medium">{t("taskManager.history.empty.none")}</p>
            )}
            {emptyKind === "error" && (
              <>
                <AlertCircle className="text-destructive size-5" />
                <p className="text-sm font-medium">{t("taskManager.history.empty.error")}</p>
                <Button variant="outline" size="sm" onClick={history.refresh}>
                  {t("taskManager.history.actions.refresh")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="flex min-h-full flex-col gap-5">
            <section
              aria-label={t("taskManager.history.chart.label")}
              className="flex flex-col gap-1"
            >
              <div className="grid grid-cols-[minmax(128px,150px)_minmax(0,1fr)] gap-3">
                <div className="flex flex-col">
                  {currentMetrics.map((metric) => {
                    const point = readout && (metric.available?.(readout) ?? true) ? readout : null;
                    return (
                      <div
                        key={metric.id}
                        style={{ height: HISTORY_CHART_HEIGHT }}
                        className="flex flex-col justify-center gap-0.5 pr-1"
                      >
                        <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                          <span
                            aria-hidden
                            className="inline-block w-3 shrink-0 border-t-2"
                            style={{ borderColor: metric.color }}
                          />
                          <span className="truncate">{metric.label}</span>
                          <span className="ml-auto tabular-nums">
                            {metric.scaleLabel(maxima.get(metric.id) ?? 100)}
                          </span>
                        </span>
                        <span className="text-[18px] leading-tight font-semibold tabular-nums">
                          {point ? metric.format(point) : "—"}
                        </span>
                        {point && metric.detail && (
                          <span className="text-muted-foreground truncate text-[10px]">
                            {metric.detail(point)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div
                  ref={plotRef}
                  className="relative"
                  style={{
                    height: currentMetrics.length * HISTORY_CHART_HEIGHT + HISTORY_AXIS_HEIGHT,
                  }}
                >
                  <div className="flex flex-col">
                    {currentMetrics.map((metric) => (
                      <HistoryChart
                        key={metric.id}
                        view={view}
                        ticks={ticks}
                        color={metric.color}
                        value={metric.value}
                        peak={metric.peak}
                        max={maxima.get(metric.id) ?? 1}
                        cursor={cursorPoint}
                        label={`${t("taskManager.history.chart.label")} — ${metric.label}`}
                      />
                    ))}
                  </div>

                  <HistoryAxis view={view} ticks={ticks} formatTick={time.tick} />

                  <div
                    role="slider"
                    tabIndex={0}
                    aria-label={t("taskManager.history.chart.cursor")}
                    aria-valuemin={view.from}
                    aria-valuemax={view.to}
                    aria-valuenow={cursorTs ?? view.to}
                    aria-valuetext={time.moment(cursorTs ?? view.to)}
                    onPointerMove={(event) => setHoverTs(timeAt(event))}
                    onPointerLeave={() => setHoverTs(null)}
                    onClick={(event) => {
                      const ts = timeAt(event);
                      if (ts === null) return;
                      history.setPinned(ts);
                      event.currentTarget.focus();
                    }}
                    onKeyDown={onKeyDown}
                    className="absolute inset-0 cursor-crosshair outline-none"
                  >
                    {pinnedFraction !== null && (
                      <span
                        aria-hidden
                        className="bg-foreground/40 pointer-events-none absolute inset-y-0 w-px"
                        style={{ left: `${pinnedFraction * 100}%` }}
                      />
                    )}
                    {hoverFraction !== null && (
                      <span
                        aria-hidden
                        className="bg-foreground/60 pointer-events-none absolute inset-y-0 w-px"
                        style={{ left: `${hoverFraction * 100}%` }}
                      />
                    )}
                    {activeTs !== null && labelFraction !== null && (
                      <span
                        className="bg-popover/90 text-foreground pointer-events-none absolute top-0 -translate-x-1/2 rounded px-1 text-[10px] tabular-nums shadow-sm"
                        style={{ left: `${labelFraction * 100}%` }}
                      >
                        {time.cursor(activeTs, span)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">{t("taskManager.history.process.title")}</h2>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {history.moment
                    ? time.moment(history.moment.system.ts)
                    : history.momentLoading
                      ? t("taskManager.history.chart.loading")
                      : ""}
                </span>
              </header>
              <HistoryProcessTable
                rows={history.moment?.processes ?? []}
                liveByPid={live.byPid}
                liveByName={live.byName}
                onActivate={activate}
                empty={t("taskManager.history.process.empty")}
              />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
