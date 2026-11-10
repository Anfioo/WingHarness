// The space preview preferences, kept current.
//
// The settings window and the tray both write `preview.json`; the backend emits
// `sp:preferences-changed` on every write, including the tray's space switch, so
// this hook follows the file rather than keeping a second copy of the rules.

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getPreviewPreferences, savePreviewPreferences, type PreviewPreferences } from "@/commands";

/** Mirrors the backend's defaults, so a failed load still previews sensibly. */
const DEFAULT_PREFERENCES: PreviewPreferences = {
  version: 1,
  spaceEnabled: true,
  readingWidth: 900,
  fontSize: 15,
  defaultEncoding: "auto",
  textPreviewThresholdKb: 500,
};

export function useSpacePreviewPreferences(): {
  preferences: PreviewPreferences;
  loading: boolean;
  save: (next: PreviewPreferences) => Promise<void>;
} {
  const [preferences, setPreferences] = useState<PreviewPreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    getPreviewPreferences()
      .then((next) => {
        if (alive) setPreferences(next);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the space preview preferences:", error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    // The tray writes the same file; follow it without echoing the change back.
    const unlisten = listen<PreviewPreferences>("sp:preferences-changed", (event) => {
      if (alive) setPreferences(event.payload);
    });

    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const save = useCallback(async (next: PreviewPreferences) => {
    setPreferences(await savePreviewPreferences(next));
  }, []);

  return { preferences, loading, save };
}
