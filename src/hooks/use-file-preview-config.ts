import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getConfig, type FilePreviewConfig } from "@/commands";

/** The defaults are the backend's own, so a failed load still previews sensibly. */
const DEFAULT_CONFIG: FilePreviewConfig = { maxBytes: 64 * 1024 * 1024, highlight: true };

/**
 * The preview page's config, kept current.
 *
 * The cap itself is enforced by the backend on every read; the page only needs
 * it to decide whether the edit button may appear. The highlight switch is
 * drawn here, so a change in the settings window is picked up without a reload.
 */
export function useFilePreviewConfig(): FilePreviewConfig {
  const [config, setConfig] = useState<FilePreviewConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    let alive = true;

    const load = () => {
      getConfig()
        .then((view) => {
          if (alive) setConfig(view.config.filePreview);
        })
        .catch((error: unknown) => {
          console.error("Failed to load the file preview settings:", error);
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
