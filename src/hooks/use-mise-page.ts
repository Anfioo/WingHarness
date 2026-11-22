import { useCallback, useEffect, useState } from "react";
import { isMiseError, miseRuntimeInfo, type MiseError, type MiseRuntimeInfo } from "@/commands";

export type MiseTab = "overview" | "tools" | "projects" | "config";

export type MisePageState = {
  tab: MiseTab;
  setTab: (tab: MiseTab) => void;
  runtime: MiseRuntimeInfo | null;
  runtimeError: MiseError | null;
  loading: boolean;
  refreshNonce: number;
  reloadRuntime: () => Promise<void>;
  /** Reload the runtime and bump the nonce so the current tab remounts. */
  refresh: () => Promise<void>;
};

function toMiseError(value: unknown): MiseError {
  if (isMiseError(value)) return value;
  return {
    code: "internal",
    message: value instanceof Error ? value.message : String(value),
    detail: null,
  };
}

/**
 * The environment page's shared state: the selected tab, the runtime probe and
 * the refresh nonce. Each tab owns its own data and reloads when it remounts,
 * so the nonce is how the page header makes the current tab reload itself.
 */
export function useMisePage(): MisePageState {
  const [tab, setTab] = useState<MiseTab>("overview");
  const [runtime, setRuntime] = useState<MiseRuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState<MiseError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const reloadRuntime = useCallback(async () => {
    try {
      setRuntime(await miseRuntimeInfo());
      setRuntimeError(null);
    } catch (failure) {
      setRuntimeError(toMiseError(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadRuntime();
  }, [reloadRuntime]);

  const refresh = useCallback(async () => {
    await reloadRuntime();
    setRefreshNonce((nonce) => nonce + 1);
  }, [reloadRuntime]);

  return { tab, setTab, runtime, runtimeError, loading, refreshNonce, reloadRuntime, refresh };
}
