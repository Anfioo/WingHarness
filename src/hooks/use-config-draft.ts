import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getConfig, saveConfig, type AppConfig, type ConfigView } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * Loads the app config into an editable draft and persists it 400ms after the
 * last change.
 *
 * Every settings section edits the same document and saves it the same way, so
 * the load/clone/debounce dance lives here once. `saveLabel` only names the
 * section in the auto-save failure log (e.g. "project config").
 */
export function useConfigDraft(saveLabel: string) {
  const { t } = useAppTranslation();
  const [view, setView] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getConfig();
      setView(next);
      setDraft(structuredClone(next.config));
      loadedOnce.current = true;
    } catch (error) {
      console.error("Failed to load config:", error);
      toast.error(t("config.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-save: persist draft 400ms after the last change (skipping initial load).
  useEffect(() => {
    if (!loadedOnce.current || !draft) return;
    const id = setTimeout(async () => {
      try {
        const next = await saveConfig(draft);
        setView(next);
      } catch (error) {
        console.error(`Failed to auto-save ${saveLabel}:`, error);
      }
    }, 400);
    return () => clearTimeout(id);
  }, [draft, saveLabel]);

  return { view, draft, setDraft, loading };
}
