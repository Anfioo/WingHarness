import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useUpdater } from "@/hooks/use-updater";
import { updateErrorMessage } from "@/lib/updater";
import { useAppTranslation } from "@/hooks/use-app-translation";

const AUTO_CHECK_SESSION_KEY = "wingharness-updater-auto-check-started";

/**
 * Runs the startup update check once per session (mounted by the main window's
 * shell). A found update opens the standalone update window; a failed check is
 * surfaced with the underlying reason so "更新失败" is diagnosable.
 */
export function UpdaterAutoCheck() {
  const { checkUpdate, downloading } = useUpdater();
  const didAutoCheck = useRef(false);
  const { t } = useAppTranslation();

  useEffect(() => {
    if (
      didAutoCheck.current ||
      downloading ||
      sessionStorage.getItem(AUTO_CHECK_SESSION_KEY) === "true"
    ) {
      return;
    }

    didAutoCheck.current = true;
    sessionStorage.setItem(AUTO_CHECK_SESSION_KEY, "true");
    void checkUpdate().then((result) => {
      if (result.status === "error") {
        toast.error(t("updater.checkFailed"), { description: updateErrorMessage(result.error) });
      }
    });
  }, [checkUpdate, downloading, t]);

  return null;
}
