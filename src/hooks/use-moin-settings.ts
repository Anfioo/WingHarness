import { useCallback, useEffect, useRef, useState } from "react";
import {
  isMoinError,
  moinErrorKey,
  moinGetSettings,
  moinPatchSettings,
  type MoinSettings,
} from "@/commands";

/**
 * Download settings with an optimistic-free patch path: the engine validates,
 * persists and echoes the whole document back, so the hook always stores what
 * the backend actually accepted. `error` is an i18n key.
 */
export function useMoinSettings(): {
  settings: MoinSettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  patch: (patch: Partial<MoinSettings>) => Promise<void>;
  reload: () => Promise<void>;
} {
  const [settings, setSettings] = useState<MoinSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await moinGetSettings();
      if (!mounted.current) return;
      setSettings(next);
      setError(null);
    } catch (failure) {
      if (!mounted.current) return;
      setError(isMoinError(failure) ? moinErrorKey(failure.code) : moinErrorKey(undefined));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const patch = useCallback(async (patch: Partial<MoinSettings>) => {
    setSaving(true);
    try {
      const next = await moinPatchSettings(patch);
      if (!mounted.current) return;
      setSettings(next);
      setError(null);
    } catch (failure) {
      if (!mounted.current) return;
      setError(isMoinError(failure) ? moinErrorKey(failure.code) : moinErrorKey(undefined));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { settings, loading, saving, error, patch, reload };
}
