// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { oneMailMessageRaw, type RawMessage } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useOneMailPageContext } from "@/pages/one-mail/context";

/**
 * The raw message from the server: headers verbatim and the body reduced to
 * plain text.
 *
 * The body is fetched through the frozen `oneMailMessageRaw` wrapper when the
 * dialog opens. Nothing here is rendered as HTML — the body becomes text, so a
 * script in the source can never run.
 */

type RawState = { status: "loading" } | { status: "error" } | { status: "ready"; raw: RawMessage };

const COPY_FEEDBACK_MS = 2000;

export default function RawMessageDialog() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();
  const [state, setState] = useState<RawState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [copied, setCopied] = useState(false);

  const rawMessageId = page.rawMessageId;

  useEffect(() => {
    if (rawMessageId === null) return;

    let active = true;
    setState({ status: "loading" });
    setCopied(false);
    oneMailMessageRaw(rawMessageId)
      .then((raw) => {
        if (active) setState({ status: "ready", raw });
      })
      .catch(() => {
        if (active) setState({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, [rawMessageId, reloadToken]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = () => {
    if (state.status !== "ready") return;
    const bodyText = state.raw.bodyText ?? htmlToText(state.raw.bodyHtml);
    const text = `${state.raw.headers.trimEnd()}\n\n${bodyText}`;
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <Dialog
      open={rawMessageId !== null}
      onOpenChange={(open) => {
        if (!open) page.closeRawMessage();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("oneMail.thread.raw")}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] min-w-0 overflow-auto">
          {state.status === "loading" && (
            <p role="status" className="text-muted-foreground text-sm">
              {t("oneMail.common.loading")}
            </p>
          )}

          {state.status === "error" && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1">{t("oneMail.errors.internal")}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setReloadToken((current) => current + 1)}
              >
                {t("oneMail.common.retry")}
              </Button>
            </div>
          )}

          {state.status === "ready" && (
            <div className="space-y-4">
              <pre className="text-foreground/90 font-mono text-xs break-all whitespace-pre-wrap">
                {state.raw.headers.trimEnd()}
              </pre>
              {(state.raw.bodyText ?? state.raw.bodyHtml) && (
                <pre className="border-border border-t pt-3 font-sans text-xs break-words whitespace-pre-wrap">
                  {state.raw.bodyText ?? htmlToText(state.raw.bodyHtml)}
                </pre>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={state.status !== "ready"}
            onClick={handleCopy}
          >
            {copied ? (
              <Check aria-hidden className="size-4" />
            ) : (
              <Copy aria-hidden className="size-4" />
            )}
            {t("oneMail.common.copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The HTML body as text, for readers that show the plain-text variant. */
function htmlToText(html: string | null): string {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, noscript, head").forEach((node) => {
    node.remove();
  });
  return (template.content.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
