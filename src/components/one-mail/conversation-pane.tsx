// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, MessageCircle, Users } from "lucide-react";
import { toast } from "sonner";
import type { MessageSummary } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useOneMailPageContext } from "@/pages/one-mail/context";
import MessageBubble from "./message-bubble";
import ReplyComposer from "./reply-composer";

/**
 * The reading lane: participants and messages in one thread, laid out as a
 * conversation rather than as a stack of forms.
 *
 * Each message is a bubble with its own hover actions; the reply box sits at
 * the foot of the thread, and the participants dialog opens from the header.
 * Switching a conversation scrolls to the newest message once, so a body that
 * arrives later never pulls the reader away.
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
    bodyState,
    loadBody,
    composer,
    openRawMessage,
    toggleStar,
    settings,
    accounts,
    setOutboxOpen,
    reloadConversations,
    reloadAccounts,
  } = page;

  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationKey = thread?.conversationKey ?? null;
  const [replyTarget, setReplyTarget] = useState<MessageSummary | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Scroll to the bottom when a conversation opens — and only then, so a body
  // arriving later does not yank the reader away from the message above.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setReplyTarget(null);
  }, [conversationKey]);

  const messages = useMemo(() => thread?.groups.flatMap((group) => group.messages) ?? [], [thread]);
  const latest = useMemo(() => latestMessage(messages), [messages]);

  const account = thread
    ? accounts.find((entry) => entry.accountId === thread.accountId)
    : undefined;
  const accountAddress = account?.email ?? "";
  const participantEmails = (thread?.participants ?? [])
    .map((participant) => participant.email)
    .join(", ");

  const reply = (message: MessageSummary) => {
    setReplyTarget(message);
    setFocusToken((current) => current + 1);
  };

  const copyParticipants = () => {
    if (!participantEmails) return;
    void navigator.clipboard
      .writeText(participantEmails)
      .then(() => toast.success(t("oneMail.common.copied")))
      .catch(() => toast.error(t("oneMail.common.copyFailed")));
  };

  if (!selectedConversationKey) {
    return (
      <section className="conversation-empty flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6 text-center">
        <MessageCircle aria-hidden className="text-muted-foreground size-16 stroke-1 opacity-25" />
        <p className="text-muted-foreground text-sm">{t("oneMail.thread.selectConversation")}</p>
        <Button variant="outline" onClick={composer.openNew}>
          {t("oneMail.list.newMessage")}
        </Button>
      </section>
    );
  }

  return (
    <section className="conversation-pane flex h-full min-h-0 flex-col">
      <header className="border-border flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2">
        <button
          type="button"
          onClick={copyParticipants}
          title={participantEmails}
          className="focus-visible:ring-ring/50 min-w-0 flex-1 truncate rounded text-left text-sm leading-5 font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          {thread ? participantEmails : t("oneMail.common.loading")}
        </button>
        {account && (
          <Badge variant="secondary" className="h-5 shrink-0 rounded-full px-2 text-[10px]">
            {account.accountLabel}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={copyParticipants}
          aria-label={t("oneMail.thread.copyAddresses")}
          title={t("oneMail.thread.copyAddresses")}
        >
          <Copy className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={() => setParticipantsOpen(true)}
          aria-label={t("oneMail.thread.participants")}
          title={t("oneMail.thread.participants")}
        >
          <Users className="size-4" aria-hidden />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            setShowScrollToBottom(
              element.scrollHeight - element.scrollTop - element.clientHeight > 2
            );
          }}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]"
        >
          {threadError && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs"
            >
              <span>{threadError}</span>
              <Button variant="outline" size="sm" onClick={reloadThread}>
                {t("oneMail.common.retry")}
              </Button>
            </div>
          )}

          {thread?.truncated && (
            <p className="text-muted-foreground mb-3 text-xs">{t("oneMail.thread.truncated")}</p>
          )}

          {threadLoading && !thread && (
            <div
              role="status"
              aria-label={t("oneMail.thread.loadingBody")}
              className="space-y-6 pt-5"
            >
              {[false, true, false].map((outgoing, index) => (
                <div
                  key={index}
                  className={
                    outgoing ? "flex flex-row-reverse items-start gap-3" : "flex items-start gap-3"
                  }
                >
                  <Skeleton className="size-10 shrink-0 rounded-full" />
                  <div className="w-3/5 space-y-2">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-28 w-full rounded-lg" />
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

          <TooltipProvider delayDuration={200}>
            <div>
              {thread?.groups.map((group) => (
                <section key={group.threadKey}>
                  <div className="text-muted-foreground my-4 flex items-center gap-3 text-xs">
                    <span aria-hidden className="bg-border h-px flex-1" />
                    <span className="max-w-[75%] text-center break-words">
                      {group.subject ?? t("oneMail.thread.noSubject")}
                    </span>
                    <span aria-hidden className="bg-border h-px flex-1" />
                  </div>
                  {[...group.messages].sort(byReceivedAtAsc).map((message) => (
                    <MessageBubble
                      key={message.messageId}
                      message={message}
                      outgoing={
                        Boolean(accountAddress) &&
                        message.fromEmail?.toLowerCase() === accountAddress.toLowerCase()
                      }
                      accountAddress={accountAddress}
                      body={bodyState[message.messageId]}
                      bodyDisplayMode={settings?.bodyDisplayMode ?? "text"}
                      remoteImagesPolicy={settings?.remoteImagesPolicy ?? "block"}
                      onLoadBody={() => loadBody(message.messageId)}
                      onReply={() => reply(message)}
                      onForward={() => void composer.openForward(message)}
                      onRaw={() => openRawMessage(message.messageId)}
                      onToggleStar={() => void toggleStar(message)}
                    />
                  ))}
                </section>
              ))}
            </div>
          </TooltipProvider>
        </div>

        {showScrollToBottom && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="bg-background absolute right-6 bottom-4 z-10 rounded-full shadow-md"
            aria-label={t("oneMail.thread.scrollToBottom")}
            title={t("oneMail.thread.scrollToBottom")}
            onClick={() => {
              const element = scrollRef.current;
              if (element) element.scrollTop = element.scrollHeight;
              setShowScrollToBottom(false);
            }}
          >
            <ChevronDown className="size-4" aria-hidden />
          </Button>
        )}
      </div>

      {thread && (
        <ReplyComposer
          key={thread.conversationKey}
          conversation={thread}
          latestMessage={latest}
          replyTarget={replyTarget}
          onReplyTargetChange={setReplyTarget}
          focusToken={focusToken}
          accounts={accounts}
          onSent={() => {
            reloadThread();
            reloadConversations();
            void reloadAccounts();
          }}
          onOpenOutbox={() => setOutboxOpen(true)}
        />
      )}

      <Dialog open={participantsOpen} onOpenChange={setParticipantsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("oneMail.thread.participants")}</DialogTitle>
            <DialogDescription>{t("oneMail.thread.participantsHint")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 space-y-1.5 overflow-y-auto">
            {(thread?.participants ?? []).map((participant) => (
              <li
                key={participant.email}
                className="bg-muted/40 flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">
                  {participant.name?.trim() || participant.email}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded text-xs focus-visible:ring-2 focus-visible:outline-none"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(participant.email)
                      .then(() => toast.success(t("oneMail.common.copied")))
                      .catch(() => toast.error(t("oneMail.common.copyFailed")));
                  }}
                  title={t("oneMail.thread.copyAddress")}
                >
                  {participant.email}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-between gap-2">
            <Button variant="outline" size="sm" onClick={copyParticipants}>
              <Copy className="size-4" aria-hidden />
              {t("oneMail.thread.copyAddresses")}
            </Button>
            <Button size="sm" onClick={() => setParticipantsOpen(false)}>
              {t("oneMail.common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Newest message of the thread: the reply box's default target. */
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
