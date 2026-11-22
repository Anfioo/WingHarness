// The overview tab's data: one dashboard load on mount, an explicit reload, and
// the full history fetched only when the history dialog is opened. There is no
// polling: the page shell remounts the tab when its refresh button is pressed.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  miseDashboard,
  miseErrorCode,
  miseHistoryList,
  type MiseDashboard,
  type MiseErrorCode,
  type MiseHistoryEntry,
} from "@/commands";

export type MiseOverviewState = {
  dashboard: MiseDashboard | null;
  loading: boolean;
  error: MiseErrorCode | null;
  reload: () => Promise<void>;
  /** The full history, empty until `openHistory` has run. */
  history: MiseHistoryEntry[];
  historyLoading: boolean;
  /** Fetch the complete history, then let the caller open the dialog. */
  openHistory: () => Promise<void>;
};

export function useMiseOverview(): MiseOverviewState {
  const [dashboard, setDashboard] = useState<MiseDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MiseErrorCode | null>(null);
  const [history, setHistory] = useState<MiseHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const cancelled = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await miseDashboard();
      if (cancelled.current) return;
      // Keep the previous dashboard during a reload, so the page does not blank.
      setDashboard(next);
      setError(null);
    } catch (failure) {
      if (!cancelled.current) setError(miseErrorCode(failure) ?? "internal");
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void reload();
    return () => {
      cancelled.current = true;
    };
  }, [reload]);

  const openHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const entries = await miseHistoryList();
      if (!cancelled.current) setHistory(entries);
    } catch (failure) {
      if (!cancelled.current) setError(miseErrorCode(failure) ?? "internal");
    } finally {
      if (!cancelled.current) setHistoryLoading(false);
    }
  }, []);

  return { dashboard, loading, error, reload, history, historyLoading, openHistory };
}
