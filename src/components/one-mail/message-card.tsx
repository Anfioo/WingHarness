// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Forward,
  MoreHorizontal,
  Reply,
  ReplyAll,
  RotateCw,
  ScrollText,
  Star,
} from "lucide-react";
import {
  oneMailMessageGet,
  type AttachmentInfo,
  type MessageBodyLoad,
  type MessageSummary,
} from "@/commands";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { splitQuotedText, stripSignature } from "@/lib/one-mail/quote";
import { cn } from "@/lib/utils";
import { avatarTone } from "./conversation-row";
import MessageAttachments from "./message-attachments";
import MessageHtml from "./message-html";

/**
 * One message in the conversation pane.
 *
 * The body is not fetched up front: the card watches its own visibility and
 * asks the page for the body the first time it enters the viewport. While the
 * request is in flight it shows a skeleton, and a failed request keeps its
 * retry affordance. Body display follows the settings choice between the
 * sanitized HTML preview and plain text with the quote and signature folded.
 */

/** One or two letters for the avatar: the name when there is one, else the address. */
export function initialsFor(name: string | null | undefined, email: string): string {
  const source = (name ?? "").trim() || email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

export interface MessageCardProps {
  message: MessageSummary;
  accountLabel: string;
  /** The page's body state for this message: absent, loading, or the result. */
  body: MessageBodyLoad | "loading" | undefined;
  onLoadBody: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onRaw: () => void;
  onToggleStar: () => void;
  bodyDisplayMode: "text" | "html";
  remoteImagesPolicy: "block" | "load";
}

export default function MessageCard({
  message,
  accountLabel,
  body,
  onLoadBody,
  onReply,
  onReplyAll,
  onForward,
  onRaw,
  onToggleStar,
  bodyDisplayMode,
  remoteImagesPolicy,
}: MessageCardProps) {
  const { t, language } = useAppTranslation();
  const cardRef = useRef<HTMLElement>(null);
  const bodyRequested = useRef(false);
  const attachmentsRequested = useRef(false);
  const onLoadBodyRef = useRef(onLoadBody);
  const [attachments, setAttachments] = useState<AttachmentInfo[] | null>(null);
  const [showQuoted, setShowQuoted] = useState(false);
  const [loadRemoteImages, setLoadRemoteImages] = useState(false);

  useEffect(() => {
    onLoadBodyRef.current = onLoadBody;
  }, [onLoadBody]);

  // The first time the card is visible, ask for the body and (when the summary
  // says there are attachments) for the metadata that the body response does
  // not carry. Each request is sent once per card.
  useEffect(() => {
    const element = cardRef.current;
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
          onLoadBodyRef.current();
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
  }, [body, message.hasAttachments, message.messageId, attachments]);

  const bodyData = body !== undefined && body !== "loading" ? body.body : null;
  const bodyError = body !== undefined && body !== "loading" ? body.error : null;
  const plainText = bodyData?.bodyText ?? "";

  const textParts = useMemo(() => {
    if (!plainText) return null;
    const quote = splitQuotedText(plainText);
    const signature = stripSignature(quote.visible);
    return {
      visible: signature.visible,
      signature: signature.signature,
      quoted: quote.quoted,
    };
  }, [plainText]);

  const showHtml = bodyDisplayMode === "html" && Boolean(bodyData?.bodyHtml);
  const showBodySkeleton = body === undefined || body === "loading";
  const allowExternalImages = remoteImagesPolicy === "load" || loadRemoteImages;
  const sender = message.fromName?.trim() || message.fromEmail || "";
  const hasHiddenText = Boolean(textParts?.quoted || textParts?.signature);

  return (
    <article ref={cardRef} className="border-border bg-card rounded-lg border p-3 shadow-xs">
      <header className="flex items-start gap-3">
        <Avatar aria-hidden className="mt-0.5 size-8">
          <AvatarFallback
            className={cn("text-[10px] font-semibold", avatarTone(message.fromEmail || sender))}
          >
            {initialsFor(message.fromName, message.fromEmail ?? "")}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {!message.isRead && (
              <>
                <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" />
                <span className="sr-only">{t("oneMail.conversations.unread")}</span>
              </>
            )}
            <span className="min-w-0 truncate text-sm font-medium">{sender}</span>
            <time
              dateTime={message.receivedAt ?? undefined}
              className="text-muted-foreground ml-auto shrink-0 text-[11px] whitespace-nowrap tabular-nums"
            >
              {formatMessageTime(message.receivedAt, language)}
            </time>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
            {message.fromEmail && message.fromEmail !== sender && (
              <span className="text-muted-foreground truncate text-[11px]">
                {message.fromEmail}
              </span>
            )}
            {accountLabel && (
              <Badge variant="outline" className="h-[18px] rounded-full px-1.5 text-[10px]">
                {accountLabel}
              </Badge>
            )}
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-pressed={message.isStarred}
          aria-label={t("oneMail.conversations.starred")}
          onClick={onToggleStar}
          className="shrink-0"
        >
          <Star
            aria-hidden
            className={cn("size-4", message.isStarred && "fill-amber-400 text-amber-400")}
          />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-haspopup="menu"
              aria-label={t("oneMail.thread.messageActions")}
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={onReply}>
              <Reply />
              {t("oneMail.thread.reply")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onReplyAll}>
              <ReplyAll />
              {t("oneMail.thread.replyAll")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onForward}>
              <Forward />
              {t("oneMail.thread.forward")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRaw}>
              <ScrollText />
              {t("oneMail.thread.raw")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="mt-3 min-w-0">
        {showBodySkeleton && (
          <div role="status" aria-label={t("oneMail.thread.loadingBody")} className="space-y-2">
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}

        {bodyError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
          >
            <span className="min-w-0 flex-1">{bodyError}</span>
            <Button type="button" variant="ghost" size="xs" onClick={onLoadBody}>
              <RotateCw aria-hidden className="size-3" />
              {t("oneMail.common.retry")}
            </Button>
          </div>
        )}

        {!bodyError && showHtml && bodyData?.bodyHtml && (
          <MessageHtml
            html={bodyData.bodyHtml}
            allowExternalImages={allowExternalImages}
            onLoadExternalImages={() => setLoadRemoteImages(true)}
          />
        )}

        {!bodyError && !showHtml && textParts && (
          <div className="space-y-2">
            <p className="text-sm leading-6 [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
              {textParts.visible}
            </p>
            {hasHiddenText && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-expanded={showQuoted}
                  onClick={() => setShowQuoted((current) => !current)}
                >
                  {showQuoted ? (
                    <ChevronUp aria-hidden className="size-3" />
                  ) : (
                    <ChevronDown aria-hidden className="size-3" />
                  )}
                  {showQuoted ? t("oneMail.thread.hideQuoted") : t("oneMail.thread.showQuoted")}
                </Button>
                {showQuoted && (
                  <div className="border-border text-muted-foreground space-y-2 border-l-2 pl-3 text-sm leading-6">
                    {textParts.signature && (
                      <p className="[overflow-wrap:anywhere] break-words whitespace-pre-wrap">
                        {textParts.signature}
                      </p>
                    )}
                    {textParts.quoted && (
                      <p className="[overflow-wrap:anywhere] break-words whitespace-pre-wrap">
                        {textParts.quoted}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {!bodyError && !showHtml && !textParts && bodyData && message.snippet && (
          <p className="text-muted-foreground text-sm leading-6 break-words">{message.snippet}</p>
        )}
      </div>

      {attachments && attachments.length > 0 && (
        <div className="mt-3">
          <MessageAttachments attachments={attachments} />
        </div>
      )}
    </article>
  );
}
