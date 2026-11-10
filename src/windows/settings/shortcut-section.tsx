import { useCallback, useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { ShortcutField } from "@/components/shortcut-field";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { registerShortcut, unregisterShortcut } from "@/lib/shortcut";
import type { ShortcutPresetId } from "@/lib/shortcut-spec";
import { toggleWindow } from "@/lib/window";

const SHOW_MAIN_KEY = "global-shortcut-show-main";

/** Ctrl+W is the one-click offer for the show-main shortcut. */
const SHOW_MAIN_PRESETS: readonly ShortcutPresetId[] = ["ctrlW"];

/**
 * The shortcut settings.
 *
 * The show-main shortcut is OS-global: it is registered here, stored under the
 * key the main window reads at startup, and mirrored to that window through
 * `shortcut-changed` so both copies agree.
 */
export function ShortcutSection() {
  const [showMain, setShowMain] = useState("");
  const { t } = useAppTranslation();

  const showMainWindow = useCallback(async () => {
    await toggleWindow("main");
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(SHOW_MAIN_KEY) ?? "";
    setShowMain(saved);
    if (saved) void registerShortcut(saved, showMainWindow);
  }, [showMainWindow]);

  const changeShowMain = async (next: string) => {
    const previous = showMain;
    setShowMain(next);

    if (next) {
      localStorage.setItem(SHOW_MAIN_KEY, next);
      await registerShortcut(next, showMainWindow, previous);
      await emit("shortcut-changed", { shortcut: next });
      toast.success(t("settings.shortcut.setSuccess", { shortcut: next }));
    } else {
      localStorage.removeItem(SHOW_MAIN_KEY);
      await unregisterShortcut(previous);
      await emit("shortcut-changed", { shortcut: "" });
      toast.info(t("settings.shortcut.cleared"));
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.shortcut.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.shortcut.description")}</p>
      </div>

      <div className="space-y-0">
        <div className="flex items-center justify-between py-2.5">
          <div className="flex-1">
            <label className="text-sm font-medium">{t("settings.shortcut.showMain")}</label>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t("settings.shortcut.showMainDesc")}
            </p>
          </div>
          <ShortcutField value={showMain} onChange={changeShowMain} presets={SHOW_MAIN_PRESETS} />
        </div>
      </div>
    </div>
  );
}
