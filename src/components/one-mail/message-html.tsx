// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useMemo, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { prepareMailHtml } from "@/lib/one-mail/mail-html";

export interface MessageHtmlProps {
  html: string;
  /** `true` restores the parked remote URLs; `false` keeps them blocked. */
  allowExternalImages: boolean;
  onLoadExternalImages: () => void;
}

/**
 * The message body rendered with the sender's own layout.
 *
 * `prepareMailHtml` removes everything executable and unsafe, keeps the table
 * and inline-style layout, and blocks remote images until the reader opts in
 * for this message. The rendered markup is the preparer's output only; nothing
 * else is ever assigned to `innerHTML`.
 */
export default function MessageHtml({
  html,
  allowExternalImages,
  onLoadExternalImages,
}: MessageHtmlProps) {
  const { t } = useAppTranslation();
  const prepared = useMemo(
    () => prepareMailHtml(html, { allowExternalImages }),
    [html, allowExternalImages]
  );

  const showBlockedNotice = !allowExternalImages && prepared.blockedImageResourceCount > 0;

  return (
    <div className="space-y-2">
      <div
        className="mail-html conversation-html text-sm"
        onClick={handleLinkClick}
        // The markup is the sanitized output of `prepareMailHtml`.
        dangerouslySetInnerHTML={{ __html: prepared.html }}
      />
      {showBlockedNotice && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span>
            {t("oneMail.thread.remoteImagesBlocked", {
              count: prepared.blockedImageResourceCount,
            })}
          </span>
          <Button type="button" variant="outline" size="xs" onClick={onLoadExternalImages}>
            {t("oneMail.thread.loadRemoteImages")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Links open in the system browser. The webview never navigates: the click is
 * always cancelled, and a link without an allowed scheme does nothing.
 */
function handleLinkClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a");
  if (!anchor) return;

  event.preventDefault();
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!/^(?:https?:|mailto:|tel:)/i.test(href)) return;
  void openUrl(href).catch(() => undefined);
}
