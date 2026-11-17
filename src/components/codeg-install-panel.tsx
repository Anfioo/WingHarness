import { useCallback, useState } from "react";
import { Download, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { openPath, type CodegInstall, type CodegMode, type CodegRelease } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  checkCodegRelease,
  installCodegServer,
  type CodegInstallProgress,
} from "@/lib/codeg/install";
import { formatBytes, formatSpeed } from "@/lib/moin/format";
import { cn } from "@/lib/utils";

export type CodegInstallPanelProps = {
  /** The archive as it stands on disk. */
  install: CodegInstall;
  /** The page's own mode, so the panel can warn about a running server. */
  mode: CodegMode;
  /** Whether the server is up; an install has to stop it first. */
  running: boolean;
  /** Stops the server before an install replaces the folder it runs from. */
  onBeforeInstall?: () => Promise<void>;
  /** Called with the new state once an install finished. */
  onInstalled?: (install: CodegInstall) => void | Promise<void>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The install half of production Codeg: which archive is on disk, and the button
 * that puts the newest one there.
 *
 * Shared by the settings partition and by the Codeg page's "not installed"
 * panel, because the two are the same question asked from two places — the page
 * has to be able to install itself, and the settings partition has to be able to
 * update what the page runs.
 */
export function CodegInstallPanel({
  install,
  mode,
  running,
  onBeforeInstall,
  onInstalled,
}: CodegInstallPanelProps) {
  const { t } = useAppTranslation();

  const [release, setRelease] = useState<CodegRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<CodegInstallProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const busy = progress !== null;

  const check = useCallback(async () => {
    setChecking(true);
    setFailure(null);
    try {
      setRelease(await checkCodegRelease());
    } catch (error) {
      console.error("Failed to check the Codeg release:", error);
      setFailure(messageOf(error));
    } finally {
      setChecking(false);
    }
  }, []);

  const installRelease = async (target: CodegRelease) => {
    if (busy) return;
    setFailure(null);
    try {
      if (running) {
        setProgress({ phase: "extract" });
        await onBeforeInstall?.();
      }
      setProgress({ phase: "download", received: 0, total: null, speed: 0 });
      const next = await installCodegServer(target, setProgress);
      await onInstalled?.(next);
      setRelease(null);
      toast.success(t("codeg.settings.install.installedToast", { version: next.version ?? "" }));
    } catch (error) {
      console.error("Failed to install codeg-server:", error);
      setFailure(messageOf(error));
    } finally {
      setProgress(null);
    }
  };

  // A manifest that names the installed version has nothing to offer; anything
  // else — a different version, or nothing installed at all — is one download.
  const installable = release !== null && (!install.installed || release.updateAvailable);

  return (
    <div className="space-y-3">
      <div className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-lg p-3 text-sm">
        {install.installed ? (
          <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
            {t("codeg.settings.install.present")}
          </Badge>
        ) : (
          <Badge variant="destructive">{t("codeg.settings.install.missing")}</Badge>
        )}
        {install.installed && install.version && (
          <span className="text-muted-foreground font-mono text-xs">{install.version}</span>
        )}
        {install.tag && (
          <span className="text-muted-foreground font-mono text-[11px]">{install.tag}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy || checking}
            onClick={() => void check()}
          >
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {checking ? t("codeg.settings.install.checking") : t("codeg.settings.install.check")}
          </Button>
          {install.installed && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void openPath(install.dir)}
              title={t("codeg.settings.install.openFolder")}
            >
              <FolderOpen />
              {t("codeg.settings.install.openFolder")}
            </Button>
          )}
        </div>
      </div>

      {release && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {t("codeg.settings.install.latest", {
              version: release.version,
              endpoint: release.endpoint,
            })}
          </span>
          {installable ? (
            <Button size="xs" disabled={busy} onClick={() => void installRelease(release)}>
              <Download />
              {install.installed
                ? t("codeg.settings.install.updateAction", { version: release.version })
                : t("codeg.settings.install.installAction", { version: release.version })}
            </Button>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">
              {t("codeg.settings.install.upToDate")}
            </span>
          )}
        </div>
      )}

      {progress && (
        <div className="space-y-1">
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" />
              {progress.phase === "download"
                ? t("codeg.settings.install.downloading")
                : progress.phase === "extract"
                  ? t("codeg.settings.install.unpacking")
                  : t("codeg.settings.install.writing", {
                      done: progress.done,
                      total: progress.total,
                    })}
            </span>
            {progress.phase === "download" && progress.value !== undefined && (
              <span className="tabular-nums">{Math.round(progress.value * 100)}%</span>
            )}
          </div>
          <Progress
            value={
              progress.phase === "download"
                ? (progress.value ?? 1) * 100
                : progress.phase === "write"
                  ? progress.value * 100
                  : 100
            }
            className={cn(
              progress.phase === "extract" ||
                (progress.phase === "download" && progress.value === undefined)
                ? "animate-pulse"
                : undefined
            )}
          />
          {progress.phase === "download" && (
            <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
              <span>
                {t("codeg.settings.install.bytes", {
                  received: formatBytes(progress.received),
                  total: formatBytes(progress.total),
                })}
              </span>
              {progress.speed > 0 && <span>{formatSpeed(progress.speed)}</span>}
            </div>
          )}
        </div>
      )}

      {failure && (
        <p className="text-destructive font-mono text-[11px] whitespace-pre-wrap">{failure}</p>
      )}

      <div className="space-y-1 text-[11px]">
        <p className="text-muted-foreground">{t("codeg.settings.install.staticDir")}</p>
        <p className="truncate font-mono" title={install.staticDir}>
          {install.staticDir || "—"}
        </p>
        <p className="text-muted-foreground">{t("codeg.settings.install.serverPath")}</p>
        <p className="truncate font-mono" title={install.serverPath}>
          {install.serverPath || "—"}
        </p>
        <p className="text-muted-foreground">{t("codeg.settings.install.hint")}</p>
        {!install.installed && (
          <p className="text-muted-foreground">
            {mode === "installed"
              ? t("codeg.settings.install.missingHint")
              : t("codeg.settings.install.missingHintDev")}
          </p>
        )}
      </div>
    </div>
  );
}
