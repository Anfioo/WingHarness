// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import type { MessageSummary } from "@/commands";

/**
 * Text helpers for the conversation pane: splitting a body into its visible
 * part and the quoted history, pulling the signature off, normalising subjects
 * and building the quote block a reply starts with.
 *
 * Everything here is pure string work; nothing touches the DOM or the IPC
 * surface, so the composer and the message card can share it.
 */

const QUOTE_LINE = /^\s*>/;
const QUOTE_SEPARATOR =
  /^\s*(?:-{2,}\s*(?:original message|forwarded message|原始邮件|转发邮件)\s*-{2,}|(?:发件人|发件时间|发送时间|from|sent)\s*[:：]\s*$)/i;
const ON_WROTE = /^\s*on\b.+wrote:\s*$/i;
const SUBJECT_PREFIX = /^\s*(?:re|fw|fwd|回复|回覆|答复|答覆|转发|轉發)\s*(?:\[\d+\])?\s*[:：]\s*/i;
const SIGNATURE_DELIMITER = /^--\s*$/;
const SENT_FROM = /^\s*(?:sent from my|sent from|发自我的|从我的)\b/i;
const QUOTE_COLLAPSE_CHARS = 200;
const QUOTE_COLLAPSE_LINES = 2;

/**
 * Split a plain-text body where the quoted history starts.
 *
 * A body is only split when something remains above the quote and the quoted
 * part is worth hiding: at least two non-empty lines or 200 characters.
 */
export function splitQuotedText(text: string): { visible: string; quoted: string | null } {
  const lines = text.split(/\r?\n/);

  let start = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (QUOTE_LINE.test(line) || QUOTE_SEPARATOR.test(line) || ON_WROTE.test(line)) {
      start = index;
      break;
    }
  }

  if (start <= 0) return { visible: text, quoted: null };

  const visible = lines.slice(0, start).join("\n").trimEnd();
  const quoted = lines.slice(start).join("\n");
  const quotedLineCount = quoted.split("\n").filter((line) => line.trim().length > 0).length;

  if (!visible.trim()) return { visible: text, quoted: null };
  if (quoted.length < QUOTE_COLLAPSE_CHARS && quotedLineCount < QUOTE_COLLAPSE_LINES) {
    return { visible: text, quoted: null };
  }

  return { visible, quoted };
}

/**
 * Pull the signature off the end of a body.
 *
 * A line consisting of `--` (the RFC 3676 delimiter) or a closing
 * "Sent from my …" line starts the signature. The signature is returned on its
 * own so the card can fold it together with the quoted history.
 */
export function stripSignature(text: string): { visible: string; signature: string | null } {
  const lines = text.split(/\r?\n/);

  for (let index = 1; index < lines.length; index += 1) {
    if (!SIGNATURE_DELIMITER.test(lines[index])) continue;
    const signature = lines
      .slice(index + 1)
      .join("\n")
      .trim();
    if (!signature) break;
    return { visible: lines.slice(0, index).join("\n").trimEnd(), signature };
  }

  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (!lines[index].trim()) continue;
    if (!SENT_FROM.test(lines[index])) break;
    const signature = lines.slice(index).join("\n").trim();
    const visible = lines.slice(0, index).join("\n").trimEnd();
    if (!visible.trim()) break;
    return { visible, signature };
  }

  return { visible: text, signature: null };
}

/**
 * A stable key for "this is the same topic": reply and forward prefixes
 * dropped, whitespace collapsed, case folded.
 */
export function normalizeSubject(subject: string): string {
  let value = subject;
  let previous = "";
  while (value !== previous) {
    previous = value;
    value = value.replace(SUBJECT_PREFIX, "");
  }
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The quote block a reply starts with: the "On <date>, <sender> wrote:" line
 * followed by the source body under `> ` prefixes. A body that has not been
 * loaded falls back to the message snippet.
 */
export function quoteForReply(message: MessageSummary, bodyText: string | null): string {
  const source = (bodyText ?? message.snippet ?? "").replace(/\r\n/g, "\n").trim();
  const sender = message.fromName?.trim() || message.fromEmail?.trim() || "";
  const date = message.receivedAt ? formatQuoteDate(message.receivedAt) : "";

  const header =
    date && sender
      ? `On ${date}, ${sender} wrote:`
      : sender
        ? `${sender} wrote:`
        : date
          ? `On ${date}:`
          : "wrote:";

  if (!source) return `${header}\n`;

  const quoted = source
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  return `${header}\n\n${quoted}\n`;
}

function formatQuoteDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
