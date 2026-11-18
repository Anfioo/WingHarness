// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useCallback, useEffect, useState } from "react";
import {
  oneMailErrorCode,
  oneMailSettingsGet,
  oneMailSettingsSet,
  type OneMailSettings,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { oneMailErrorKey } from "@/lib/one-mail/error-key";

export type OneMailSettingsState = {
  settings: OneMailSettings | null;
  loading: boolean;
  saving: boolean;
  /** A localized message for the last failed load or save. */
  error: string | null;
  reload: () => Promise<void>;
  /** Save a whole document; `null` means the write failed and `error` is set. */
  save: (next: OneMailSettings) => Promise<OneMailSettings | null>;
};

/**
 * The Settings window's mail partition: read and write `settings.json`.
 *
 * The page listens for `one-mail:settings-changed`, which the backend emits
 * after every successful save, so it needs no extra wiring here.
 */
export function useOneMailSettings(): OneMailSettingsState {
  const { t } = useAppTranslation();
  const [settings, setSettings] = useState<OneMailSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describeError = useCallback(
    (failure: unknown) => t(oneMailErrorKey(oneMailErrorCode(failure))),
    [t]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSettings(await oneMailSettingsGet());
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }, [describeError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (next: OneMailSettings) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await oneMailSettingsSet(next);
        setSettings(saved);
        return saved;
      } catch (failure) {
        setError(describeError(failure));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [describeError]
  );

  return { settings, loading, saving, error, reload, save };
}
