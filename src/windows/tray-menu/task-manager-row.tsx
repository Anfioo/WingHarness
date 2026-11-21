// The tray's background-monitoring switch.
//
// The row is a plain setting toggle: it hides no flyout and starts no sampling.
// It reads the persistent setting on mount and again every time Rust shows the
// popup, because the window outlives any single showing and the settings
// window or the task manager page may have changed the value while it was
// hidden. The backend's change event covers the same window being visible.

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Activity } from "lucide-react";
import { toast } from "sonner";
import { argusSettingsGet, argusSetBackgroundMonitoring, type ArgusSettings } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { TASK_MANAGER_SETTINGS_EVENT } from "@/lib/task-manager/settings-event";
import { cn } from "@/lib/utils";

// Emitted by `tray_popup.rs` just before the popup is shown.
const OPENED_EVENT = "tray-menu:opened";

export function TaskManagerRow() {
  const { t } = useAppTranslation();
  /** The persisted value; null until the first read lands and while it fails. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEnabled((await argusSettingsGet()).backgroundMonitoring);
    } catch {
      // Without the stored value there is nothing safe to flip; leave the row
      // disabled until the next open retries.
      setEnabled(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const unlistenSettings = listen<ArgusSettings>(TASK_MANAGER_SETTINGS_EVENT, (event) =>
      setEnabled(event.payload.backgroundMonitoring)
    );
    const unlistenOpened = listen(OPENED_EVENT, () => void load());
    return () => {
      void unlistenSettings.then((off) => off());
      void unlistenOpened.then((off) => off());
    };
  }, [load]);

  const toggle = useCallback(async () => {
    if (enabled === null || busy) return;
    const previous = enabled;
    const next = !previous;
    // Show the new position at once: the switch is the feedback, and a round
    // trip through the backend would make the row feel stuck.
    setEnabled(next);
    setBusy(true);
    try {
      setEnabled((await argusSetBackgroundMonitoring(next)).backgroundMonitoring);
    } catch {
      setEnabled(previous);
      toast.error(t("tray.taskManager.toggleFailed"));
    } finally {
      setBusy(false);
    }
  }, [busy, enabled, t]);

  const checked = enabled === true;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={enabled === null || busy}
      onClick={() => void toggle()}
      className="hover:bg-accent hover:text-accent-foreground flex h-8 shrink-0 items-center gap-2 rounded-sm px-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Activity className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("tray.taskManager.background")}</span>
      <span
        className={cn(
          "flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-xs transition-colors",
          checked ? "bg-primary" : "bg-input"
        )}
      >
        <span
          className={cn(
            "bg-background block size-4 rounded-full shadow-lg transition-transform",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </span>
    </button>
  );
}
