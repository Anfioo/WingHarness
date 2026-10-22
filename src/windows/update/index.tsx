import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowRight, CircleArrowUp, RotateCw, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useUpdater } from "@/hooks/use-updater";
import { updateErrorMessage } from "@/lib/updater";
import { toast } from "sonner";

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function getProgressPercentage(progress: ReturnType<typeof useUpdater>["progress"]): number {
  if (!progress || progress.event === "Started") return 0;
  if (progress.event === "Finished") return 100;
  const { downloaded, contentLength } = progress.data || {};
  if (!contentLength) return 0;
  return Math.round(((downloaded ?? 0) / contentLength) * 100);
}

/**
 * The update prompt as its own window: new version, publish date and release
 * notes, with "skip this version" beside the install button. A skipped version
 * stops the startup prompt until something newer is published.
 *
 * While a download runs, closing only hides the window: the download channel
 * and the relaunch-after-install live in this webview, and destroying it would
 * orphan both.
 */
export default function UpdatePage() {
  const { t } = useAppTranslation();
  const {
    update,
    availableVersion,
    downloading,
    cancelling,
    checking,
    progress,
    checkUpdate,
    installUpdate,
    cancelDownload,
    skipUpdate,
  } = useUpdater();
  const appWindow = useMemo(() => getCurrentWebviewWindow(), []);
  const [focused, setFocused] = useState(true);
  const [checkError, setCheckError] = useState<string | null>(null);
  const downloadingRef = useRef(downloading);

  useEffect(() => {
    downloadingRef.current = downloading;
  }, [downloading]);

  // Close = hide while downloading, destroy otherwise.
  useEffect(() => {
    const unlistenClose = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (downloadingRef.current) {
        await appWindow.hide();
      } else {
        await appWindow.destroy();
      }
    });

    const unlistenFocus = appWindow.onFocusChanged(({ payload }) => setFocused(payload));

    return () => {
      unlistenClose.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
    };
  }, [appWindow]);

  const hydrate = useCallback(async () => {
    setCheckError(null);
    const result = await checkUpdate({ force: true, openWindow: false });
    if (result.status === "error") {
      setCheckError(updateErrorMessage(result.error));
    }
  }, [checkUpdate]);

  // This window's provider starts empty — the check ran elsewhere. Whenever the
  // window is front and its update object does not match the latest known
  // version (freshly opened, or a newer release arrived while hidden), fetch
  // the metadata again. A version the user skipped still hydrates here so a
  // forced manual check finds the prompt ready.
  useEffect(() => {
    if (!focused || downloading) {
      return;
    }

    if (!availableVersion) {
      if (!update) {
        // Nothing left to show (the update vanished elsewhere): the window is
        // stale, so take it down.
        void appWindow.destroy();
      }
      return;
    }

    if (update?.version !== availableVersion) {
      void hydrate();
    }
  }, [appWindow, availableVersion, downloading, focused, hydrate, update]);

  const handleInstall = async () => {
    try {
      await installUpdate();
    } catch (error) {
      console.error("Failed to install update:", error);
      toast.error(t("updater.installFailed"), { description: updateErrorMessage(error) });
    }
  };

  const handleCancelDownload = async () => {
    try {
      if (await cancelDownload()) {
        toast.info(t("updater.downloadCancelled"));
      }
    } catch (error) {
      console.error("Failed to cancel update download:", error);
      toast.error(t("updater.cancelFailed"));
    }
  };

  const handleSkip = () => {
    skipUpdate();
    void appWindow.hide();
  };

  const installing = progress?.event === "Finished";

  const footer = (() => {
    if (downloading) {
      if (installing) {
        return (
          <p className="text-muted-foreground text-center text-sm">
            {t("updater.installingVersion", { version: update?.version ?? availableVersion })}
          </p>
        );
      }
      return (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => void handleCancelDownload()}
          disabled={cancelling}
        >
          <XIcon data-icon="inline-start" />
          {cancelling ? t("updater.cancelling") : t("updater.cancelDownload")}
        </Button>
      );
    }

    if (!update) {
      return (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => void hydrate()}
          disabled={checking}
        >
          <RotateCw data-icon="inline-start" className={checking ? "animate-spin" : undefined} />
          {t("updater.retry")}
        </Button>
      );
    }

    return (
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={handleSkip}>
          {t("updater.skipVersion")}
        </Button>
        <Button onClick={() => void handleInstall()} disabled={checking}>
          {t("updater.installNow")}
        </Button>
      </div>
    );
  })();

  return (
    <WindowFrame
      titleBar={
        <TitleBar
          title={t("updater.windowTitle")}
          showPin
          showMinimize={false}
          showMaximize={false}
        />
      }
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
            <CircleArrowUp className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t("updater.updateAvailable")}</h2>
            {update ? (
              <div className="mt-1 flex items-center gap-1.5">
                <Badge variant="secondary" className="font-mono">
                  v{update.currentVersion}
                </Badge>
                <ArrowRight className="text-muted-foreground size-3.5" />
                <Badge className="font-mono">v{update.version}</Badge>
              </div>
            ) : (
              availableVersion && <Badge className="mt-1 font-mono">v{availableVersion}</Badge>
            )}
          </div>
        </div>

        {update?.date && (
          <p className="text-muted-foreground text-xs">
            {t("updater.publishedAt")}
            {formatPublishedAt(update.date)}
          </p>
        )}

        {downloading ? (
          <div className="flex flex-col gap-2">
            <Progress value={getProgressPercentage(progress)} />
            <p className="text-muted-foreground text-center text-xs">
              {t("updater.downloading")} {getProgressPercentage(progress)}%
            </p>
          </div>
        ) : checkError && !update ? (
          <div className="bg-destructive/10 text-destructive flex flex-col gap-1 rounded-md p-3 text-sm">
            <p className="font-semibold">{t("updater.checkFailed")}</p>
            <p className="break-all whitespace-pre-wrap">{checkError}</p>
          </div>
        ) : update?.body ? (
          <div className="bg-muted flex min-h-0 flex-1 flex-col gap-1 rounded-md p-3">
            <p className="text-sm font-semibold">{t("updater.releaseNotes")}</p>
            <div className="text-muted-foreground min-h-0 flex-1 overflow-y-auto text-sm whitespace-pre-wrap">
              {update.body}
            </div>
          </div>
        ) : (
          !update && (
            <p className="text-muted-foreground flex-1 text-center text-sm">
              {t("updater.checking")}
            </p>
          )
        )}

        <div className="shrink-0">{footer}</div>
      </div>
    </WindowFrame>
  );
}
