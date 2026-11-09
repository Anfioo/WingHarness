// The space preview preferences, kept current.
//
// A0 ships a working read/save pair over the frozen command wrappers. F4 takes
// this over when the settings section and the page need to react to changes
// from another window.

import { useCallback, useEffect, useState } from "react";
import { getPreviewPreferences, savePreviewPreferences, type PreviewPreferences } from "@/commands";

/** Mirrors the backend's defaults, so a failed load still previews sensibly. */
const DEFAULT_PREFERENCES: PreviewPreferences = {
  version: 1,
  spaceEnabled: true,
  readingWidth: 900,
  fontSize: 15,
  defaultEncoding: "auto",
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

    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (next: PreviewPreferences) => {
    setPreferences(await savePreviewPreferences(next));
  }, []);

  return { preferences, loading, save };
}
