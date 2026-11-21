// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The history tab's data: one window of recorded frames, the moment picked on
// the charts and the recorder's on/off state.
//
// The tab only calls the history wrappers. While it follows the present it
// re-queries the window every 10 s (1 h, 6 h) or 60 s (24 h, 7 d); picking a
// moment freezes the window, so the recorder is never polled for a view that
// cannot change. Everything stops while the tab is not the active one or the
// document is hidden.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  argusHistoryMoment,
  argusHistorySeries,
  argusSettingsGet,
  type ArgusSettings,
  type HistoryMoment,
  type HistoryPoint,
} from "@/commands";
import { subscribeTaskManagerSettings } from "@/lib/task-manager/settings-event";
import {
  buildHistoryView,
  emptyHistoryView,
  historyRange,
  type HistoryRange,
  type HistoryRangeId,
  type HistoryView,
} from "@/lib/task-manager/history-range";

type Query = { from: number; to: number; buckets: number };

type Data = { query: Query; view: HistoryView };

export type TaskManagerHistory = {
  rangeId: HistoryRangeId;
  range: HistoryRange;
  /** The window drawn: the newest answer, or an empty window while loading. */
  view: HistoryView;
  moment: HistoryMoment | null;
  loading: boolean;
  momentLoading: boolean;
  /** True once the first series query has settled (success or failure). */
  loaded: boolean;
  /** The last series query failed. */
  error: boolean;
  /** Background monitoring is off, so nothing new is being recorded. */
  recordingOff: boolean;
  /** Following new frames (no pinned moment, no frozen window). */
  following: boolean;
  pinnedTs: number | null;
  chooseRange: (id: HistoryRangeId) => void;
  setPinned: (ts: number) => void;
  backToLatest: () => void;
  refresh: () => void;
};

export function useTaskManagerHistory(active: boolean): TaskManagerHistory {
  const [rangeId, setRangeId] = useState<HistoryRangeId>("1h");
  const range = useMemo(() => historyRange(rangeId), [rangeId]);
  const [pinnedTs, setPinnedTs] = useState<number | null>(null);
  /** End of the window while looking into the past; null keeps it at the present. */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [moment, setMoment] = useState<HistoryMoment | null>(null);
  const [momentLoading, setMomentLoading] = useState(false);
  const [recordingOff, setRecordingOff] = useState(false);
  /** Drops the answer of a query a newer one has replaced. */
  const seriesSeq = useRef(0);

  const query = useMemo<Query>(() => {
    const to = anchor ?? now;
    return { from: to - range.ms, to, buckets: range.buckets };
  }, [anchor, now, range]);

  const loadSeries = useCallback(async (next: Query) => {
    const seq = seriesSeq.current + 1;
    seriesSeq.current = seq;
    setLoading(true);
    try {
      const points: HistoryPoint[] = await argusHistorySeries(next.from, next.to, next.buckets);
      if (seq !== seriesSeq.current) return;
      setData({ query: next, view: buildHistoryView(next.from, next.to, next.buckets, points) });
      setError(false);
    } catch {
      if (seq !== seriesSeq.current) return;
      setError(true);
    } finally {
      if (seq === seriesSeq.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  // A hidden tab keeps the last answer; becoming active follows the present again.
  useEffect(() => {
    if (!active) return;
    const current = Date.now();
    setNow((stored) => (current - stored > 1_000 ? current : stored));
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void loadSeries(query);
  }, [active, query, loadSeries]);

  // Follow new frames only while the present is shown, and only while visible.
  useEffect(() => {
    if (!active || pinnedTs !== null || anchor !== null) return;
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const timer = window.setInterval(tick, range.refreshMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, pinnedTs, anchor, range.refreshMs]);

  // The process table describes the pinned moment, or the newest frame shown.
  const momentTs = pinnedTs ?? data?.view.to ?? null;

  useEffect(() => {
    if (!active || momentTs === null) {
      setMoment(null);
      setMomentLoading(false);
      return;
    }
    let cancelled = false;
    setMomentLoading(true);
    argusHistoryMoment(momentTs)
      .then((next) => {
        if (!cancelled) setMoment(next);
      })
      .catch(() => {
        if (!cancelled) setMoment(null);
      })
      .finally(() => {
        if (!cancelled) setMomentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, momentTs]);

  // The recorder's switch lives in the settings store; the backend broadcasts
  // every change, so the tab and the settings window stay in step.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const apply = (settings: ArgusSettings) => {
      if (!disposed) setRecordingOff(!settings.backgroundMonitoring);
    };
    argusSettingsGet()
      .then(apply)
      .catch(() => undefined);
    void subscribeTaskManagerSettings(apply)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const chooseRange = useCallback(
    (id: HistoryRangeId) => {
      const next = historyRange(id);
      setRangeId(id);
      if (pinnedTs === null) {
        setAnchor(null);
        return;
      }
      // Keep the picked moment in the middle of the new view.
      const end = pinnedTs + next.ms / 2;
      setAnchor(end < Date.now() ? end : null);
    },
    [pinnedTs]
  );

  const setPinned = useCallback((ts: number) => setPinnedTs(ts), []);

  const backToLatest = useCallback(() => {
    setPinnedTs(null);
    setAnchor(null);
    setNow(Date.now());
  }, []);

  const refresh = useCallback(() => {
    if (pinnedTs === null && anchor === null) {
      setNow(Date.now());
      return;
    }
    void loadSeries(query);
  }, [pinnedTs, anchor, query, loadSeries]);

  // A view is only used for the range it was queried for: switching ranges
  // shows the empty window instead of old points on a new axis.
  const view = useMemo(() => {
    const span = Math.round(data ? data.view.to - data.view.from : 0);
    if (data && data.query.buckets === query.buckets && span === range.ms) return data.view;
    return emptyHistoryView(query.from, query.to, query.buckets);
  }, [data, query, range.ms]);

  return {
    rangeId,
    range,
    view,
    moment,
    loading,
    momentLoading,
    loaded,
    error,
    recordingOff,
    following: pinnedTs === null && anchor === null,
    pinnedTs,
    chooseRange,
    setPinned,
    backToLatest,
    refresh,
  };
}
