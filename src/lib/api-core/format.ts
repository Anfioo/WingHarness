/**
 * Display formatting helpers for the API client: byte and duration sizes, JSON
 * and XML pretty-printing, content-type lookup and truncation. The pretty
 * printers are lossless on failure — they return the original text when the
 * input does not parse.
 */
import type { KeyValue } from "@/lib/api-core/types";

/** Format a byte count as B/KB/MB with at most one decimal place. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${formatScaled(kb)} KB`;
  return `${formatScaled(kb / 1024)} MB`;
}

/** One decimal below 100, whole numbers above, so columns stay narrow. */
function formatScaled(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

/** Format a duration in milliseconds as ms/s/min. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  return `${(seconds / 60).toFixed(2)} min`;
}

/** Pretty-print JSON with two-space indent; returns the input on parse failure. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

type XmlToken =
  | { type: "open"; raw: string; name: string; selfClosing: boolean }
  | { type: "close"; raw: string; name: string }
  | { type: "other"; raw: string }
  | { type: "text"; raw: string };

const XML_TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/[^>]+>|<[^>]+>|[^<]+/g;

/**
 * Pretty-print XML with two-space indent. Returns the input unchanged when the
 * document is empty or irregular (unbalanced tags, unquoted `>` in attributes),
 * so callers can safely fall back to raw text.
 */
export function prettyXml(text: string): string {
  const source = text.trim();
  if (source === "") return text;
  const tokens = tokenizeXml(source);
  if (tokens === null) return text;

  const lines: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "text") {
      const value = token.raw.trim();
      if (value !== "") lines.push(`${indent(depth)}${value}`);
      continue;
    }
    if (token.type === "close") {
      depth = Math.max(0, depth - 1);
      lines.push(`${indent(depth)}${token.raw}`);
      continue;
    }
    if (token.type === "other") {
      lines.push(`${indent(depth)}${token.raw.trim()}`);
      continue;
    }
    lines.push(`${indent(depth)}${token.raw.trim()}`);
    if (!token.selfClosing) depth += 1;
  }
  return lines.join("\n");
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

/** Split XML into tokens, validating tag balance; `null` when the document is suspect. */
function tokenizeXml(source: string): XmlToken[] | null {
  const tokens: XmlToken[] = [];
  const stack: string[] = [];
  XML_TOKEN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = XML_TOKEN_RE.exec(source)) !== null) {
    const raw = match[0];

    if (raw.startsWith("</")) {
      const close = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(raw);
      if (!close || stack.pop() !== close[1]) return null;
      tokens.push({ type: "close", raw, name: close[1] });
      continue;
    }
    if (
      raw.startsWith("<?") ||
      raw.startsWith("<!--") ||
      raw.startsWith("<![CDATA[") ||
      raw.startsWith("<!")
    ) {
      tokens.push({ type: "other", raw });
      continue;
    }
    if (raw.startsWith("<")) {
      const selfClosing = raw.endsWith("/>");
      const inner = selfClosing ? raw.slice(0, -2) : raw;
      const open = /^<([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(inner);
      if (!open) return null;
      if (!selfClosing) stack.push(open[1]);
      tokens.push({ type: "open", raw, name: open[1], selfClosing });
      continue;
    }
    tokens.push({ type: "text", raw });
  }

  return stack.length === 0 ? tokens : null;
}

/**
 * Return the value of the `content-type` header (case-insensitive), or `null`
 * when it is absent or empty. Disabled headers are ignored.
 */
export function detectContentType(headers: KeyValue[]): string | null {
  for (const header of headers) {
    if (!header.enabled) continue;
    if (header.key.trim().toLowerCase() !== "content-type") continue;
    const value = header.value.trim();
    if (value !== "") return value;
  }
  return null;
}

/**
 * Cut `text` to at most `limit` characters for display, appending an ellipsis
 * when it was shortened. Non-positive limits yield an empty string.
 */
export function truncateForDisplay(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}
