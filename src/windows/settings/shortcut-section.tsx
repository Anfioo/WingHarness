import { useCallback, useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { getConfig, saveConfig } from "@/commands";
import { ShortcutField } from "@/components/shortcut-field";
import { HelpTip } from "@/components/ui/help-tip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { registerShortcut, unregisterShortcut } from "@/lib/shortcut";
import { type ShortcutPresetId } from "@/lib/shortcut-spec";
import { toggleWindow } from "@/lib/window";

const SHOW_MAIN_KEY = "global-shortcut-show-main";

/**
 * What the quick look offers. These are the triggers that imitate the system
 * file manager; a combination can still be picked in the same control.
 */
const QUICK_PREVIEW_PRESETS: readonly ShortcutPresetId[] = [
  "space",
  "doubleCtrl",
  "altSpace",
  "winSpace",
];

/**
 * The shortcut settings.
 *
 * The show-main shortcut is OS-global: it is registered here, stored under the
 * key the main window reads at startup, and mirrored to that window through
 * `shortcut-changed` so both copies agree.
 *
 * The quick-look shortcut is in-app instead — Space and a double Ctrl cannot be
 * registered with the OS without taking them from every other program — so it
 * is saved in `config.json` and read by the file preview page.
 */
export function ShortcutSection() {
  const [showMain, setShowMain] = useState("");
  const [quickPreview, setQuickPreview] = useState("");
  const { t } = useAppTranslation();

  const showMainWindow = useCallback(async () => {
    await toggleWindow("main");
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(SHOW_MAIN_KEY) ?? "";
    setShowMain(saved);
    if (saved) void registerShortcut(saved, showMainWindow);
  }, [showMainWindow]);

  useEffect(() => {
    let alive = true;
    getConfig()
      .then((view) => {
        if (alive) setQuickPreview(view.config.shortcuts.quickPreview);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the quick preview shortcut:", error);
      });
    return () => {
      alive = false;
    };
  }, []);

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

  const changeQuickPreview = async (next: string) => {
    setQuickPreview(next);
    try {
      const view = await getConfig();
      const saved = await saveConfig({
        ...view.config,
        shortcuts: { ...view.config.shortcuts, quickPreview: next },
      });
      setQuickPreview(saved.config.shortcuts.quickPreview);
      // The file preview page keeps the trigger in step without a reload.
      await emit("config-changed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
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
          <ShortcutField value={showMain} onChange={changeShowMain} />
        </div>

        <div className="flex items-center justify-between py-2.5">
          <div className="flex-1">
            <div className="flex items-center gap-1">
              <label className="text-sm font-medium">{t("settings.shortcut.quickPreview")}</label>
              <HelpTip
                title={t("settings.shortcut.quickPreviewHelpTitle")}
                side="top"
                align="start"
              >
                {t("settings.shortcut.quickPreviewHelp")}
              </HelpTip>
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t("settings.shortcut.quickPreviewDesc")}
            </p>
          </div>
          <ShortcutField
            value={quickPreview}
            onChange={changeQuickPreview}
            presets={QUICK_PREVIEW_PRESETS}
          />
        </div>
      </div>
    </div>
  );
}
