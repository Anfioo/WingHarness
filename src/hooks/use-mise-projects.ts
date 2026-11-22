// The projects tab's data: one coverage scan on mount, an explicit reload, and
// the scan-root mutations. A mutation stores the directory list its command
// returns, then rescans so project counts and bindings follow. There is no
// polling: the page shell remounts the tab when its refresh button is pressed.

import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  isMiseError,
  miseErrorCode,
  miseProjectsScan,
  miseScanDirsAdd,
  miseScanDirsRemove,
  miseScanDirsSetEnabled,
  type MiseErrorCode,
  type MiseProjectCoverage,
  type MiseScanDirectory,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { miseErrorKey } from "@/lib/mise/error-key";

export type MiseProjectsState = {
  coverage: MiseProjectCoverage | null;
  loading: boolean;
  error: MiseErrorCode | null;
  /** A scan-root add, remove or toggle is in flight. */
  busy: boolean;
  reload: () => Promise<void>;
  /** Open the directory picker; null when the user cancels. */
  pickRoot: () => Promise<string | null>;
  addRoot: (path: string) => Promise<void>;
  removeRoot: (path: string) => Promise<void>;
  toggleRoot: (path: string, enabled: boolean) => Promise<void>;
};

/**
 * The `detail.field` an invalid-input rejection may carry. The panel shows it
 * next to the error so the rejected input can be located.
 */
function invalidField(error: unknown): string | null {
  if (!isMiseError(error) || error.code !== "invalid-input") return null;
  if (error.detail === null || typeof error.detail !== "object") return null;
  const field = (error.detail as { field?: unknown }).field;
  return typeof field === "string" ? field : null;
}

export function useMiseProjects(): MiseProjectsState {
  const { t } = useAppTranslation();
  const [coverage, setCoverage] = useState<MiseProjectCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MiseErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await miseProjectsScan();
      if (cancelled.current) return;
      // Keep the previous coverage during a reload, so the tab does not blank.
      setCoverage(next);
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

  const runMutation = useCallback(
    async (action: () => Promise<MiseScanDirectory[]>) => {
      setBusy(true);
      try {
        const directories = await action();
        if (cancelled.current) return;
        setCoverage((current) =>
          current === null ? current : { ...current, scanDirectories: directories }
        );
        setError(null);
        await reload();
      } catch (failure) {
        if (cancelled.current) return;
        const code = miseErrorCode(failure) ?? "internal";
        const field = invalidField(failure);
        setError(code);
        toast.error(t(miseErrorKey(code)), { description: field ?? undefined });
      } finally {
        if (!cancelled.current) setBusy(false);
      }
    },
    [reload, t]
  );

  const pickRoot = useCallback(async () => {
    try {
      const picked = await pickDirectory({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    } catch {
      // A refused or failed dialog is not a mise error; report it generically.
      toast.error(t(miseErrorKey("internal")));
      return null;
    }
  }, [t]);

  const addRoot = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return;
      await runMutation(() => miseScanDirsAdd(trimmed));
    },
    [runMutation]
  );

  const removeRoot = useCallback(
    async (path: string) => {
      await runMutation(() => miseScanDirsRemove(path));
    },
    [runMutation]
  );

  const toggleRoot = useCallback(
    async (path: string, enabled: boolean) => {
      await runMutation(() => miseScanDirsSetEnabled(path, enabled));
    },
    [runMutation]
  );

  return {
    coverage,
    loading,
    error,
    busy,
    reload,
    pickRoot,
    addRoot,
    removeRoot,
    toggleRoot,
  };
}
