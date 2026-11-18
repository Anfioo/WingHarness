// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useState } from "react";
import { RefreshCw, ScrollText, Send, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";

const STAGE_LABEL_KEY: Record<string, string> = {
  connecting: "oneMail.sync.connecting",
  folders: "oneMail.sync.folders",
  headers: "oneMail.sync.headers",
  saving: "oneMail.sync.saving",
  done: "oneMail.sync.done",
  error: "oneMail.sync.error",
};

/**
 * The workspace footer.
 *
 * The left side is health at a glance — sync state, accounts, message count.
 * The right side is the activity log: every sync step and new-mail event this
 * page has seen, newest last, with the same entry echoed as the button label.
 * Nothing here is written to disk; the log is the running session's memory.
 */
export default function MailStatusBar() {
  const page = useOneMailPageContext();
  const { t, language } = useAppTranslation();
  const [activityOpen, setActivityOpen] = useState(false);

  const running = page.syncing || Boolean(page.syncStatus?.running);
  const failed = !running && Boolean(page.syncStatus?.lastError);
  const issues = page.accounts.filter((account) =>
    ["auth_error", "sync_error", "network_error"].includes(account.status)
  ).length;
  const messageCount =
    page.selectedAccountId === null
      ? page.accounts.reduce((sum, account) => sum + account.totalCount, 0)
      : (page.accounts.find((account) => account.accountId === page.selectedAccountId)
          ?.totalCount ?? 0);
  const pendingOutbox = page.outbox.filter((item) => item.status !== "sent").length;

  let syncText: string;
  if (page.syncing) {
    syncText = page.syncProgress
      ? t(STAGE_LABEL_KEY[page.syncProgress.stage] ?? "oneMail.sync.connecting")
      : t("oneMail.sync.connecting");
  } else if (running) {
    syncText = t("oneMail.sync.busy");
  } else if (failed) {
    syncText = t("oneMail.sync.error");
  } else if (page.syncStatus?.lastFinishedAt) {
    syncText = t("oneMail.accounts.lastSync", {
      time: formatTime(page.syncStatus.lastFinishedAt, language),
    });
  } else {
    syncText = t("oneMail.sync.idle");
  }

  const latest = page.activityLog.at(-1);
  const latestText = latest
    ? `${latest.account ? `${latest.account}: ` : ""}${t(latest.actionKey, latest.params)}`
    : t("oneMail.status.activityIdle");

  return (
    <footer className="bg-muted/40 text-muted-foreground flex h-7 shrink-0 items-center justify-between gap-2 border-t px-2 text-[11px]">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "flex items-center gap-1.5 whitespace-nowrap",
            failed && "text-destructive",
            running && "text-sky-600 dark:text-sky-300"
          )}
          title={page.syncStatus?.lastError ?? undefined}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              failed ? "bg-destructive" : running ? "animate-pulse bg-sky-500" : "bg-emerald-500"
            )}
          />
          {syncText}
        </span>
        <span className="hidden whitespace-nowrap sm:inline">
          {t("oneMail.status.accounts", {
            healthy: page.accounts.length - issues,
            total: page.accounts.length,
          })}
        </span>
        <span className="hidden whitespace-nowrap md:inline">
          {t("oneMail.status.messages", { count: messageCount })}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-1">
        <Popover open={activityOpen} onOpenChange={setActivityOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground h-5 max-w-[min(34vw,20rem)] gap-1 px-1 text-[11px] font-normal"
              aria-label={`${t("oneMail.status.activity")}: ${latestText}`}
            >
              <ScrollText className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{latestText}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            sideOffset={6}
            className="w-[min(32rem,calc(100vw-1rem))] gap-0 overflow-hidden rounded-xl p-0 text-xs"
          >
            <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
              <span className="text-xs font-semibold">{t("oneMail.status.activity")}</span>
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground h-5 px-1.5"
                disabled={page.activityLog.length === 0}
                onClick={page.clearActivityLog}
              >
                <Trash2 className="size-3" aria-hidden />
                {t("oneMail.status.clearActivity")}
              </Button>
            </div>
            <div
              role="log"
              aria-live="off"
              className="bg-muted/50 max-h-[min(15rem,40vh)] overflow-y-auto px-3 py-2 font-mono text-[11px] leading-4"
            >
              {page.activityLog.length === 0 ? (
                <div className="text-muted-foreground">{t("oneMail.status.activityEmpty")}</div>
              ) : (
                page.activityLog.slice(-40).map((entry) => (
                  <div
                    key={entry.key}
                    className={cn(
                      "grid min-w-0 grid-cols-[4rem_minmax(0,6rem)_minmax(0,1fr)] items-center gap-x-1 whitespace-nowrap",
                      entry.tone === "success" && "text-emerald-700 dark:text-emerald-300",
                      entry.tone === "danger" && "text-destructive",
                      entry.tone === "warning" && "text-amber-700 dark:text-amber-300"
                    )}
                  >
                    <time
                      dateTime={new Date(entry.at).toISOString()}
                      className="shrink-0 tabular-nums"
                    >
                      {formatTime(new Date(entry.at).toISOString(), language)}
                    </time>
                    <span className="min-w-0 truncate">{entry.account}</span>
                    <span className="min-w-0 truncate">{t(entry.actionKey, entry.params)}</span>
                  </div>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>

        <span aria-hidden className="text-muted-foreground/50">
          ·
        </span>
        <span className="hidden shrink-0 whitespace-nowrap lg:inline">
          {t("oneMail.status.outbox", { count: pendingOutbox })}
        </span>

        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground h-5 gap-1 px-1 text-[11px] font-normal"
          aria-label={t("oneMail.outbox.title")}
          title={t("oneMail.outbox.title")}
          onClick={() => page.setOutboxOpen(true)}
        >
          <Send className="size-3.5" aria-hidden />
          {pendingOutbox > 0 && (
            <Badge
              variant="secondary"
              className="h-4 min-w-4 rounded-full px-1 text-[9px] tabular-nums"
            >
              {pendingOutbox > 99 ? "99+" : pendingOutbox}
            </Badge>
          )}
        </Button>

        {running ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground h-5 gap-1 px-1 text-[11px] font-normal"
            onClick={() => void page.cancelSync()}
          >
            <X className="size-3.5" aria-hidden />
            {t("oneMail.sync.cancel")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground h-5 gap-1 px-1 text-[11px] font-normal"
            onClick={() => void page.syncNow()}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {t("oneMail.accounts.syncNow")}
          </Button>
        )}
      </div>
    </footer>
  );
}

function formatTime(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
