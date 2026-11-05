import type { ReactNode } from "react";
import { FileWarning } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyPane } from "@/components/api-client/empty-pane";
import { detectContentType, formatBytes, prettyJson, prettyXml } from "@/lib/api-core/format";
import type { HttpResponse } from "@/lib/api-core/types";
import { escapeHtml, highlight, type BodyLanguage } from "./highlight";

/**
 * Above these lengths the body is shown verbatim: pretty-printing and syntax
 * highlighting both walk the whole string, so a multi-megabyte body would stall
 * the pane. The engine caps bodies at 32 MB, well past these thresholds.
 */
const MAX_FORMAT_LENGTH = 1_000_000;
const MAX_HIGHLIGHT_LENGTH = 200_000;

type BodyKind = "json" | "xml" | "text";

/** Pick the renderer from the content type, sniffing bare JSON as a fallback. */
function bodyKind(contentType: string, text: string): BodyKind {
  const type = contentType.toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("xml")) return "xml";
  // No usable content type: treat well-formed JSON as JSON so APIs that omit the
  // header still get a readable, highlighted body.
  if (type.trim() === "" && prettyJson(text) !== text) return "json";
  return "text";
}

/** The text handed to the clipboard for a response, preferring the text body. */
export function bodyClipboardText(response: HttpResponse): string {
  return response.bodyText ?? response.bodyBase64 ?? "";
}

/** Pre-rendered, syntax-highlighted code; `html` is already escaped by the caller. */
function CodeBlock({ html }: { html: string }): ReactNode {
  return (
    <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

/** The centered note shown when a body exists but cannot be rendered as text. */
function BinaryNote({ response }: { response: HttpResponse }): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.response" });
  return (
    <EmptyPane
      icon={<FileWarning className="size-5" />}
      title={t("body.binary.title")}
      description={t("body.binary.description", {
        contentType: response.contentType || t("body.binary.unknown"),
        size: formatBytes(response.sizeBytes),
      })}
    />
  );
}

/**
 * The Body tab: binary bodies get a note, JSON and XML are pretty-printed and
 * syntax-highlighted, and everything else falls back to plain text.
 */
export function BodyView({ response }: { response: HttpResponse }): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.response" });

  if (response.isBinary || response.bodyText === null) return <BinaryNote response={response} />;

  const text = response.bodyText;
  if (text === "") {
    return <p className="text-muted-foreground px-1 py-2 text-[11px]">{t("body.empty")}</p>;
  }

  const contentType = response.contentType || detectContentType(response.headers) || "";
  const kind = bodyKind(contentType, text);
  const language: BodyLanguage | null = kind === "text" ? null : kind;

  let display = text;
  if (language && text.length <= MAX_FORMAT_LENGTH) {
    display = language === "json" ? prettyJson(text) : prettyXml(text);
  }

  const html =
    language && display.length <= MAX_HIGHLIGHT_LENGTH
      ? highlight(display, language)
      : escapeHtml(display);

  return <CodeBlock html={html} />;
}

/** The Raw tab: the response body exactly as received, unformatted and uncoloured. */
export function RawView({ response }: { response: HttpResponse }): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.response" });

  if (response.bodyText === null) return <BinaryNote response={response} />;
  if (response.bodyText === "") {
    return <p className="text-muted-foreground px-1 py-2 text-[11px]">{t("body.empty")}</p>;
  }
  return <CodeBlock html={escapeHtml(response.bodyText)} />;
}
