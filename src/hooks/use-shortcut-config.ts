import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getConfig, type ShortcutsConfig } from "@/commands";

/** Mirrors the backend's default, so a failed load still leaves a usable trigger. */
const DEFAULT_CONFIG: ShortcutsConfig = { quickPreview: "preset:space" };

/**
 * The non-global shortcut settings, kept current.
 *
 * The settings window saves them to `config.json` and emits `config-changed`, so
 * a page that listens for the trigger picks up a new value without a reload.
 */
export function useShortcutConfig(): ShortcutsConfig {
  const [config, setConfig] = useState<ShortcutsConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    let alive = true;

    const load = () => {
      getConfig()
        .then((view) => {
          if (alive) setConfig(view.config.shortcuts);
        })
        .catch((error: unknown) => {
          console.error("Failed to load the shortcut settings:", error);
        });
    };

    load();
    const unlisten = listen("config-changed", load);
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  return config;
}
