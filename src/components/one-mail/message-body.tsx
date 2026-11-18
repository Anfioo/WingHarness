// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, RotateCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MessageBodyLoad, MessageSummary } from "@/commands";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  conversationHtmlToText,
  conversationTextParts,
  type ConversationTextLink,
} from "@/lib/one-mail/conversation-text";
import { compactMailBodyText } from "@/lib/one-mail/mail-text";
import { cn } from "@/lib/utils";
import MessageHtml from "./message-html";

/** The height a long body folds to before the reader expands it. */
const COLLAPSED_HEIGHT = 240;

export interface MessageBodyProps {
  message: MessageSummary;
  outgoing: boolean;
  /** The page's body state: absent, loading, or the result. */
  body: MessageBodyLoad | "loading" | undefined;
  bodyDisplayMode: "text" | "html";
  remoteImagesPolicy: "block" | "load";
  onRetry: () => void;
  /**
   * The hover actions. `copyBody` is `null` while the body is still loading, so
   * the copy action can disable itself.
   */
  children: (copyBody: string | null) => ReactNode;
}

/**
 * One message body in its bubble.
 *
 * Plain text is the reading-first mode: the HTML part is converted to text,
 * link targets survive, and the quoted history folds away. HTML mode keeps the
 * sender's layout through `MessageHtml`. Both modes load lazily and share the
 * same collapsed-height behaviour.
 */
export default function MessageBody({
  message,
  outgoing,
  body,
  bodyDisplayMode,
  remoteImagesPolicy,
  onRetry,
  children,
}: MessageBodyProps) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [loadRemoteImages, setLoadRemoteImages] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  const loading = body === undefined || body === "loading";
  const bodyData = !loading ? body.body : null;
  const bodyError = !loading ? body.error : null;
  const html = bodyData?.bodyHtml ?? "";
  const plainText = bodyData?.bodyText ?? "";

  const { body: textBody, links: textLinks } = useMemo(() => {
    const collected: ConversationTextLink[] = [];
    const converted = html ? conversationHtmlToText(html, collected) : "";
    return { body: converted || plainText, links: collected };
  }, [html, plainText]);

  const copyBody = useMemo(
    () => (plainText.trim() ? plainText : html ? conversationHtmlToText(html) : null),
    [plainText, html]
  );

  const showHtml = bodyDisplayMode === "html" && Boolean(html);
  const allowExternalImages = remoteImagesPolicy === "load" || loadRemoteImages;

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > COLLAPSED_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showHtml, textBody]);

  const openLink = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor || event.button > 1) return;
    event.preventDefault();
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!/^(?:https?:|mailto:|tel:)/i.test(href)) return;
    void openUrl(href).catch(() => undefined);
  };

  return (
    <div className="max-w-full min-w-0">
      <div
        className={cn(
          "conversation-bubble relative max-w-full rounded px-3 py-2.5",
          loading ? "w-80" : "w-fit",
          outgoing && "is-outgoing"
        )}
        aria-busy={loading}
      >
        <div
          className={expanded ? undefined : "overflow-hidden"}
          style={{
            maxHeight: expanded ? undefined : COLLAPSED_HEIGHT,
            maskImage:
              overflowing && !expanded
                ? "linear-gradient(to bottom, black calc(100% - 24px), transparent)"
                : undefined,
          }}
        >
          <div ref={content} className="flow-root" onClick={openLink} onAuxClick={openLink}>
            {loading ? (
              <div
                role="status"
                aria-label={t("oneMail.thread.loadingBody")}
                className="space-y-2 py-1"
              >
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="mt-4 h-4 w-2/3" />
              </div>
            ) : showHtml ? (
              <MessageHtml
                html={html}
                allowExternalImages={allowExternalImages}
                onLoadExternalImages={() => setLoadRemoteImages(true)}
              />
            ) : (
              <MessageText
                value={textBody || message.snippet || t("oneMail.thread.emptyBody")}
                links={textLinks}
                quoteLabel={t("oneMail.thread.showQuoted")}
              />
            )}
          </div>
        </div>
        {bodyError && !loading && (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {t("oneMail.thread.bodyError")}
          </p>
        )}
      </div>

      <div className="conversation-message-actions mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {overflowing && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t(
                  expanded ? "oneMail.thread.collapseMessage" : "oneMail.thread.expandMessage"
                )}
                aria-expanded={expanded}
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t(expanded ? "oneMail.thread.collapseMessage" : "oneMail.thread.expandMessage")}
            </TooltipContent>
          </Tooltip>
        )}
        {bodyError && !loading && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                aria-label={t("oneMail.common.retry")}
                onClick={onRetry}
              >
                <RotateCw className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("oneMail.common.retry")}</TooltipContent>
          </Tooltip>
        )}
        {children(copyBody)}
      </div>
    </div>
  );
}

function MessageText({
  value,
  links,
  quoteLabel,
}: {
  value: string;
  links: ConversationTextLink[];
  quoteLabel: string;
}) {
  const compactText = compactMailBodyText(value);
  const lines = compactText.split("\n");
  const quoteIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      (/^\s*>/.test(line) ||
        /^On .+wrote:\s*$/.test(line) ||
        /^-- ?$/.test(line) ||
        /^[-_]{3,}.*(Original Message|原始邮件)/i.test(line))
  );
  const visible = quoteIndex > 0 ? lines.slice(0, quoteIndex).join("\n").trimEnd() : compactText;

  return (
    <>
      <div className="space-y-1.5 text-sm leading-5 [overflow-wrap:anywhere] break-words">
        {visible.split("\n\n").map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            <LinkedText value={paragraph.trim()} links={links} />
          </p>
        ))}
      </div>
      {quoteIndex > 0 && (
        <details className="text-muted-foreground mt-2 text-xs leading-4">
          <summary className="cursor-pointer">{quoteLabel}</summary>
          <p className="mt-1.5 [overflow-wrap:anywhere] break-words whitespace-pre-line">
            <LinkedText value={lines.slice(quoteIndex).join("\n")} links={links} />
          </p>
        </details>
      )}
    </>
  );
}

function LinkedText({ value, links }: { value: string; links: ConversationTextLink[] }) {
  return conversationTextParts(value, links).map((part, index) =>
    part.href ? (
      <a
        key={index}
        href={part.href}
        title={part.href}
        target="_blank"
        rel="noopener noreferrer"
        className="focus-visible:outline-ring text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 dark:text-blue-400"
      >
        {part.text}
      </a>
    ) : (
      part.text
    )
  );
}
