// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useRef, useState } from "react";
import { Copy, Forward, Reply, ScrollText, Star } from "lucide-react";
import { toast } from "sonner";
import {
  oneMailMessageGet,
  type AttachmentInfo,
  type MessageBodyLoad,
  type MessageSummary,
} from "@/commands";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import ConversationAvatar from "./conversation-avatar";
import MessageAttachments from "./message-attachments";
import MessageBody from "./message-body";

export interface MessageBubbleProps {
  message: MessageSummary;
  /** `true` when the message was sent by the account being read. */
  outgoing: boolean;
  /** The address the account uses, for the outgoing avatar's seed. */
  accountAddress: string;
  body: MessageBodyLoad | "loading" | undefined;
  bodyDisplayMode: "text" | "html";
  remoteImagesPolicy: "block" | "load";
  onLoadBody: () => void;
  onReply: () => void;
  onForward: () => void;
  onRaw: () => void;
  onToggleStar: () => void;
}

function formatMessageTime(iso: string | null, language: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * One message in the thread: the avatar and sender line, the body bubble, and
 * the hover actions under it. A right-click on the bubble offers the same
 * reading actions as a menu, which is where "quote reply" lives.
 */
export default function MessageBubble({
  message,
  outgoing,
  accountAddress,
  body,
  bodyDisplayMode,
  remoteImagesPolicy,
  onLoadBody,
  onReply,
  onForward,
  onRaw,
  onToggleStar,
}: MessageBubbleProps) {
  const { t, language } = useAppTranslation();
  const articleRef = useRef<HTMLElement>(null);
  const bodyRequested = useRef(false);
  const attachmentsRequested = useRef(false);
  const [attachments, setAttachments] = useState<AttachmentInfo[] | null>(null);

  // The first time the message is visible, ask for the body and the attachment
  // metadata. Each request is sent once per message.
  useEffect(() => {
    const element = articleRef.current;
    if (!element) return;

    const wantsBody = body === undefined && !bodyRequested.current;
    const wantsAttachments =
      message.hasAttachments && attachments === null && !attachmentsRequested.current;
    if (!wantsBody && !wantsAttachments) return;

    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();

        if (wantsBody && !bodyRequested.current) {
          bodyRequested.current = true;
          onLoadBody();
        }
        if (wantsAttachments && !attachmentsRequested.current) {
          attachmentsRequested.current = true;
          oneMailMessageGet(message.messageId)
            .then((detail) => {
              if (active) setAttachments(detail.attachments);
            })
            .catch(() => {
              if (active) setAttachments([]);
            });
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(element);

    return () => {
      active = false;
      observer.disconnect();
    };
  }, [body, message.hasAttachments, message.messageId, attachments, onLoadBody]);

  const sender = message.fromName?.trim() || message.fromEmail || "";
  const seed = outgoing ? accountAddress : message.fromEmail || "unknown";

  const copy = (value: string | null) => {
    if (!value) return;
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.success(t("oneMail.common.copied")))
      .catch(() => toast.error(t("oneMail.common.copyFailed")));
  };

  return (
    <article
      ref={articleRef}
      data-message-id={message.messageId}
      className={cn(
        "conversation-message mb-5 flex items-start gap-3",
        outgoing && "flex-row-reverse"
      )}
    >
      <ConversationAvatar seed={seed} outgoing={outgoing} compact />
      <div
        className={cn(
          "flex max-w-[calc(100%-3.25rem)] min-w-0 flex-col items-start md:max-w-[min(80%,48rem)]",
          outgoing && "items-end"
        )}
      >
        <p className="text-muted-foreground mb-1 max-w-full text-[11px] break-all">
          <span className="text-foreground/80">{sender || t("oneMail.thread.unknownSender")}</span>
          <span aria-hidden> · </span>
          <time dateTime={message.receivedAt ?? undefined}>
            {formatMessageTime(message.receivedAt, language)}
          </time>
        </p>

        <ContextMenu>
          <ContextMenuTrigger asChild className="select-text">
            <div
              tabIndex={0}
              aria-label={`${t("oneMail.thread.messageActions")}: ${message.subject || sender}`}
              className="max-w-full min-w-0 outline-none"
            >
              <MessageBody
                message={message}
                outgoing={outgoing}
                body={body}
                bodyDisplayMode={bodyDisplayMode}
                remoteImagesPolicy={remoteImagesPolicy}
                onRetry={onLoadBody}
              >
                {(copyBody) => (
                  <>
                    <ActionButton
                      label={t("oneMail.thread.reply")}
                      onClick={onReply}
                      icon={<Reply className="size-4" />}
                    />
                    <ActionButton
                      label={t("oneMail.thread.copyMessage")}
                      onClick={() => copy(copyBody)}
                      disabled={!copyBody}
                      icon={<Copy className="size-4" />}
                    />
                    <ActionButton
                      label={t("oneMail.thread.forward")}
                      onClick={onForward}
                      icon={<Forward className="size-4" />}
                    />
                    <ActionButton
                      label={t("oneMail.thread.raw")}
                      onClick={onRaw}
                      icon={<ScrollText className="size-4" />}
                    />
                    <ActionButton
                      label={t(message.isStarred ? "oneMail.thread.unstar" : "oneMail.thread.star")}
                      onClick={onToggleStar}
                      pressed={message.isStarred}
                      icon={
                        <Star
                          className={cn(
                            "size-4",
                            message.isStarred && "fill-amber-400 text-amber-400"
                          )}
                        />
                      }
                    />
                  </>
                )}
              </MessageBody>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem onSelect={onReply}>
              <Reply className="size-4" />
              {t("oneMail.thread.quoteReply")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onForward}>
              <Forward className="size-4" />
              {t("oneMail.thread.forward")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onRaw}>
              <ScrollText className="size-4" />
              {t("oneMail.thread.raw")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onToggleStar}>
              <Star className="size-4" />
              {t(message.isStarred ? "oneMail.thread.unstar" : "oneMail.thread.star")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {attachments && attachments.length > 0 && (
          <div className="mt-2 max-w-full">
            <MessageAttachments attachments={attachments} />
          </div>
        )}
      </div>
    </article>
  );
}

function ActionButton({
  label,
  onClick,
  icon,
  disabled,
  pressed,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={disabled}
          aria-pressed={pressed}
          aria-label={label}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
