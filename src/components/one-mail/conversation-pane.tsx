// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useLayoutEffect, useMemo, useRef } from "react";
import { Forward, Mail, RefreshCw, Reply, ReplyAll, ScrollText, X } from "lucide-react";
import type { MessageSummary } from "@/commands";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";
import { avatarTone } from "./conversation-row";
import MessageCard, { initialsFor } from "./message-card";

/**
 * The reading lane: the participants and the message actions on top, then the
 * thread grouped by topic. Opening a conversation scrolls to its newest
 * message; the bodies themselves load card by card as they enter the viewport.
 */
export default function ConversationPane() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();
  const {
    thread,
    threadLoading,
    threadError,
    reloadThread,
    selectedConversationKey,
    closeConversation,
    bodyState,
    loadBody,
    composer,
    openRawMessage,
    toggleStar,
    settings,
    accounts,
  } = page;

  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationKey = thread?.conversationKey ?? null;

  // Scroll to the bottom when a conversation opens — and only then, so a body
  // arriving later does not yank the reader away from the message above.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [conversationKey]);

  const messages = useMemo(() => thread?.groups.flatMap((group) => group.messages) ?? [], [thread]);
  const latest = useMemo(() => latestMessage(messages), [messages]);

  const accountLabel = thread
    ? (accounts.find((account) => account.accountId === thread.accountId)?.accountLabel ?? "")
    : "";
  const displayName = (thread?.participants ?? [])
    .map((participant) => participant.name?.trim() || participant.email)
    .join(", ");

  if (!selectedConversationKey) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
        <Mail aria-hidden className="text-muted-foreground size-8" />
        <p className="text-muted-foreground text-sm">{t("oneMail.thread.selectConversation")}</p>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        {thread ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex items-center -space-x-2">
              {thread.participants.slice(0, 3).map((participant) => (
                <Avatar key={participant.email} className="ring-background size-7 ring-2">
                  <AvatarFallback
                    className={cn(
                      "text-[10px] font-semibold",
                      avatarTone(participant.email || "unknown")
                    )}
                  >
                    {initialsFor(participant.name, participant.email)}
                  </AvatarFallback>
                </Avatar>
              ))}
              {thread.participants.length > 3 && (
                <span className="bg-muted text-muted-foreground ring-background flex size-7 items-center justify-center rounded-full text-[10px] font-medium ring-2">
                  +{thread.participants.length - 3}
                </span>
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{displayName}</p>
              <div className="mt-0.5 flex items-center gap-1.5">
                {accountLabel && (
                  <Badge variant="secondary" className="h-[18px] rounded-full px-1.5 text-[10px]">
                    {accountLabel}
                  </Badge>
                )}
                <span aria-hidden className="text-muted-foreground text-[11px] tabular-nums">
                  {messages.length}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <Skeleton className="h-8 w-44" />
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!latest}
            onClick={() => {
              if (latest) void composer.openReply(latest, false);
            }}
          >
            <Reply aria-hidden />
            {t("oneMail.thread.reply")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!latest}
            onClick={() => {
              if (latest) void composer.openReply(latest, true);
            }}
          >
            <ReplyAll aria-hidden />
            {t("oneMail.thread.replyAll")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!latest}
            onClick={() => {
              if (latest) void composer.openForward(latest);
            }}
          >
            <Forward aria-hidden />
            {t("oneMail.thread.forward")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!latest}
            onClick={() => {
              if (latest) openRawMessage(latest.messageId);
            }}
          >
            <ScrollText aria-hidden />
            {t("oneMail.thread.raw")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("oneMail.common.close")}
            onClick={closeConversation}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {threadError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs"
          >
            <span>{threadError}</span>
            <Button variant="outline" size="sm" onClick={reloadThread}>
              <RefreshCw />
              {t("oneMail.common.retry")}
            </Button>
          </div>
        )}

        {thread?.truncated && (
          <p className="text-muted-foreground mb-3 text-xs">{t("oneMail.thread.truncated")}</p>
        )}

        {threadLoading && !thread && (
          <div role="status" aria-label={t("oneMail.common.loading")} className="space-y-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="border-border bg-card rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-2.5 w-20" />
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  <Skeleton className="h-3 w-11/12" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        )}

        {thread && messages.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t("oneMail.common.empty")}
          </p>
        )}

        {thread?.groups.map((group) => (
          <section key={group.threadKey} className="mb-4 last:mb-0">
            <div className="my-3 flex items-center gap-3">
              <span aria-hidden className="bg-border h-px flex-1" />
              <span className="text-muted-foreground max-w-[75%] truncate text-xs">
                {group.subject ?? t("oneMail.thread.noSubject")}
              </span>
              <span aria-hidden className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                {group.messages.length}
              </span>
              <span aria-hidden className="bg-border h-px flex-1" />
            </div>

            <div className="space-y-3">
              {[...group.messages].sort(byReceivedAtAsc).map((message) => (
                <MessageCard
                  key={message.messageId}
                  message={message}
                  accountLabel={accountLabel}
                  body={bodyState[message.messageId]}
                  onLoadBody={() => loadBody(message.messageId)}
                  onReply={() => void composer.openReply(message, false)}
                  onReplyAll={() => void composer.openReply(message, true)}
                  onForward={() => void composer.openForward(message)}
                  onRaw={() => openRawMessage(message.messageId)}
                  onToggleStar={() => void toggleStar(message)}
                  bodyDisplayMode={settings?.bodyDisplayMode ?? "text"}
                  remoteImagesPolicy={settings?.remoteImagesPolicy ?? "block"}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

/** Newest message of the thread: the pane's reply / forward / raw target. */
function latestMessage(messages: MessageSummary[]): MessageSummary | null {
  let latest: MessageSummary | null = null;
  for (const message of messages) {
    const time = receivedTime(message);
    if (Number.isNaN(time)) continue;
    if (latest === null || Number.isNaN(receivedTime(latest)) || time >= receivedTime(latest)) {
      latest = message;
    }
  }
  return latest ?? messages[messages.length - 1] ?? null;
}

function byReceivedAtAsc(left: MessageSummary, right: MessageSummary): number {
  const leftTime = receivedTime(left);
  const rightTime = receivedTime(right);
  if (Number.isNaN(leftTime)) return Number.isNaN(rightTime) ? 0 : 1;
  if (Number.isNaN(rightTime)) return -1;
  return leftTime - rightTime;
}

function receivedTime(message: MessageSummary): number {
  return message.receivedAt ? Date.parse(message.receivedAt) : Number.NaN;
}
