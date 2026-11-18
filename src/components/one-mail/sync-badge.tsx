// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Loader2, RefreshCw, X } from "lucide-react";
import type { OneMailSyncStatus, SyncProgressPayload, SyncStage } from "@/commands";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";

const STAGE_LABEL_KEY: Record<SyncStage, string> = {
  connecting: "oneMail.sync.connecting",
  folders: "oneMail.sync.folders",
  headers: "oneMail.sync.headers",
  saving: "oneMail.sync.saving",
  done: "oneMail.sync.done",
  error: "oneMail.sync.error",
};

/** The clock time of the last finished sync, in the page language. */
function formatSyncTime(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export interface SyncBadgeProps {
  /**
   * Every field falls back to the page context, so the page shell can render a
   * bare `<SyncBadge />` while a test or a future lane can pass its own values.
   */
  syncStatus?: OneMailSyncStatus | null;
  syncing?: boolean;
  progress?: SyncProgressPayload | null;
  onSync?: () => void;
  onCancel?: () => void;
}

/**
 * The sync state line and its single action: "last synced …" at rest, the stage
 * with a cancel button while a sync runs, and a red line with the same button
 * acting as retry after a failure.
 */
export default function SyncBadge({
  syncStatus,
  syncing,
  progress,
  onSync,
  onCancel,
}: SyncBadgeProps = {}) {
  const page = useOneMailPageContext();
  const { t, language } = useAppTranslation();

  const status = syncStatus === undefined ? page.syncStatus : syncStatus;
  const isSyncing = syncing ?? page.syncing;
  const currentProgress = progress === undefined ? page.syncProgress : progress;
  // A sync can already be running when the page mounts, so the status says so
  // even when this page did not start it and `syncing` is still false.
  const remoteRunning = !isSyncing && (status?.running ?? false);
  const running = isSyncing || remoteRunning;
  const failed = !running && Boolean(status?.lastError);

  let label: string;
  if (isSyncing) {
    label = currentProgress
      ? t(STAGE_LABEL_KEY[currentProgress.stage])
      : t("oneMail.sync.connecting");
  } else if (remoteRunning) {
    label = t("oneMail.sync.busy");
  } else if (failed) {
    label = t("oneMail.sync.error");
  } else if (status?.lastFinishedAt) {
    label = t("oneMail.accounts.lastSync", {
      time: formatSyncTime(status.lastFinishedAt, language),
    });
  } else {
    label = t("oneMail.sync.idle");
  }

  const startSync = onSync ?? (() => void page.syncNow());
  const stopSync = onCancel ?? (() => void page.cancelSync());

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span
        aria-live="polite"
        title={currentProgress?.folderPath ?? status?.lastError ?? undefined}
        className={cn(
          "flex items-center gap-1.5 text-xs whitespace-nowrap",
          failed ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {running && <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />}
        {label}
        {isSyncing && currentProgress !== null && currentProgress.fetched > 0 && (
          <span className="tabular-nums">{currentProgress.fetched}</span>
        )}
      </span>
      {running ? (
        <Button variant="outline" size="sm" onClick={stopSync}>
          <X />
          {t("oneMail.sync.cancel")}
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={startSync}>
          <RefreshCw />
          {t("oneMail.accounts.syncNow")}
        </Button>
      )}
    </div>
  );
}
