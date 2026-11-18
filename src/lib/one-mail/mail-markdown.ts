// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import DOMPurify from "dompurify";
import { marked } from "marked";

/** The two parts a composed message carries: plain text and styled HTML. */
export interface EmailParts {
  text: string;
  html: string;
}

// Mail HTML is read in other people's clients, so every rule is inline and no
// colour comes from the application theme.
const TEXT_COLOR = "#1f2937";
const MUTED_COLOR = "#4b5563";
const LINK_COLOR = "#2563eb";
const CODE_BACKGROUND = "#f3f4f6";
const BORDER_COLOR = "#e5e7eb";
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";

const BLOCK_STYLE: Record<string, Record<string, string>> = {
  p: {
    margin: "0 0 12px",
    color: TEXT_COLOR,
    fontFamily: FONT_STACK,
    fontSize: "14px",
    lineHeight: "1.6",
  },
  ul: { margin: "0 0 12px", paddingLeft: "24px", color: TEXT_COLOR },
  ol: { margin: "0 0 12px", paddingLeft: "24px", color: TEXT_COLOR },
  li: {
    margin: "4px 0",
    color: TEXT_COLOR,
    fontFamily: FONT_STACK,
    fontSize: "14px",
    lineHeight: "1.6",
  },
  blockquote: {
    margin: "0 0 12px",
    padding: "0 0 0 12px",
    borderLeft: `3px solid ${BORDER_COLOR}`,
    color: MUTED_COLOR,
    fontFamily: FONT_STACK,
    fontSize: "14px",
    lineHeight: "1.6",
  },
  pre: {
    margin: "0 0 12px",
    padding: "12px",
    background: CODE_BACKGROUND,
    borderRadius: "6px",
    color: TEXT_COLOR,
    fontFamily: MONO_STACK,
    fontSize: "13px",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  a: { color: LINK_COLOR, textDecoration: "underline" },
  strong: { fontWeight: "600" },
  em: { fontStyle: "italic" },
  hr: { border: "0", borderTop: `1px solid ${BORDER_COLOR}`, margin: "16px 0" },
  table: {
    borderCollapse: "collapse",
    width: "100%",
    margin: "0 0 12px",
    color: TEXT_COLOR,
    fontFamily: FONT_STACK,
    fontSize: "14px",
    lineHeight: "1.6",
  },
  th: {
    border: `1px solid ${BORDER_COLOR}`,
    padding: "6px 8px",
    textAlign: "left",
    verticalAlign: "top",
    background: "#f9fafb",
    fontWeight: "600",
  },
  td: {
    border: `1px solid ${BORDER_COLOR}`,
    padding: "6px 8px",
    textAlign: "left",
    verticalAlign: "top",
  },
  img: { maxWidth: "100%", height: "auto" },
};

const HEADING_STYLE: Record<string, Record<string, string>> = {
  h1: { fontSize: "24px" },
  h2: { fontSize: "20px" },
  h3: { fontSize: "18px" },
  h4: { fontSize: "16px" },
  h5: { fontSize: "14px" },
  h6: { fontSize: "13px" },
};

const UNSAFE_SELECTOR = "script, style, iframe, object, embed, form, input";
const SAFE_PROTOCOLS = /^(?:https?:|mailto:)/i;

/**
 * Markdown → the two parts of an outgoing message.
 *
 * The HTML is sanitized twice: the source document is pruned of the tags that
 * have no place in a message, then the serialized result goes through
 * DOMPurify, so nothing marked passed through as raw HTML can carry a script.
 * The text part follows the rendered document block by block, which keeps it
 * consistent with the HTML instead of re-parsing the Markdown a second way.
 */
export function markdownToEmail(source: string): EmailParts {
  if (source.trim() === "") return { text: "", html: "" };

  const rendered = marked.parse(source, { gfm: true, breaks: false, async: false });
  const doc = new DOMParser().parseFromString(rendered, "text/html");

  for (const element of Array.from(doc.querySelectorAll(UNSAFE_SELECTOR))) element.remove();
  rewriteLinks(doc);
  applyInlineStyles(doc);

  const text = documentToText(doc.body);
  const html = DOMPurify.sanitize(doc.body.innerHTML, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["target"],
  });

  return { text, html };
}

/** Links keep only the protocols a reader can safely follow. */
function rewriteLinks(doc: Document): void {
  for (const anchor of Array.from(doc.querySelectorAll("a"))) {
    anchor.removeAttribute("target");
    const href = anchor.getAttribute("href")?.trim() ?? "";
    if (!SAFE_PROTOCOLS.test(href)) anchor.removeAttribute("href");
  }
}

function applyInlineStyles(doc: Document): void {
  for (const [tag, style] of Object.entries(BLOCK_STYLE)) {
    for (const element of Array.from(doc.querySelectorAll(tag))) {
      appendStyle(element as HTMLElement, style);
    }
  }

  for (const [tag, size] of Object.entries(HEADING_STYLE)) {
    for (const heading of Array.from(doc.querySelectorAll(tag))) {
      appendStyle(heading as HTMLElement, {
        margin: "16px 0 8px",
        color: TEXT_COLOR,
        fontFamily: FONT_STACK,
        lineHeight: "1.6",
        fontWeight: "600",
        ...size,
      });
    }
  }

  for (const code of Array.from(doc.querySelectorAll("code"))) {
    const inPre = code.parentElement?.tagName === "PRE";
    appendStyle(
      code as HTMLElement,
      inPre
        ? { background: "transparent", padding: "0", fontSize: "13px", borderRadius: "0" }
        : {
            background: CODE_BACKGROUND,
            padding: "1px 4px",
            borderRadius: "3px",
            color: TEXT_COLOR,
            fontFamily: MONO_STACK,
            fontSize: "90%",
          }
    );
  }
}

function appendStyle(element: HTMLElement, style: Record<string, string>): void {
  const declarations = Object.entries(style).map(([property, value]) => `${property}: ${value};`);
  const existing = element.getAttribute("style");
  element.setAttribute(
    "style",
    existing ? `${declarations.join(" ")} ${existing}` : declarations.join(" ")
  );
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/** The whole body as plain text; empty input has already been handled. */
function documentToText(root: HTMLElement): string {
  // The unsafe tags are gone by the time this runs, so their contents never
  // reach the text part either.
  const text = blocksToText(root);
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function blocksToText(parent: Node): string {
  let text = "";
  for (const child of Array.from(parent.childNodes)) text += blockToText(child);
  return text;
}

function blockToText(node: Node): string {
  if (!(node instanceof HTMLElement)) return inlineText(node);

  switch (node.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
    case "P":
      return `${inlineText(node).trim()}\n\n`;
    case "PRE":
      return `${node.textContent ?? ""}\n\n`;
    case "HR":
      return "---\n\n";
    case "UL":
    case "OL":
      return `${listToText(node, 0)}\n\n`;
    case "BLOCKQUOTE": {
      const quoted = blocksToText(node).trim();
      if (quoted === "") return "";
      return `${quoted
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n")}\n\n`;
    }
    case "TABLE":
      return `${tableToText(node)}\n\n`;
    case "DIV":
    case "SECTION":
    case "ARTICLE":
      return blocksToText(node);
    case "BR":
      return "\n";
    default:
      return `${inlineText(node).trim()}\n\n`;
  }
}

/** Text of a node and its inline descendants; links become `label <url>`. */
function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!(node instanceof HTMLElement)) return "";

  if (node.tagName === "BR") return "\n";

  if (node.tagName === "A") {
    const label = inlineText(node).trim();
    const href = node.getAttribute("href")?.trim() ?? "";
    if (href === "") return label;
    if (label === "" || label === href) return href;
    return `${label} <${href}>`;
  }

  let text = "";
  for (const child of Array.from(node.childNodes)) text += inlineText(child);
  return text;
}

function listToText(list: HTMLElement, depth: number): string {
  const indent = "  ".repeat(depth);
  const ordered = list.tagName === "OL";
  const lines: string[] = [];
  let index = 1;

  for (const item of Array.from(list.children)) {
    if (!(item instanceof HTMLElement) || item.tagName !== "LI") continue;

    const marker = ordered ? `${index}. ` : "- ";
    index += 1;

    const nested: HTMLElement[] = [];
    let content = "";
    for (const child of Array.from(item.childNodes)) {
      if (child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL")) {
        nested.push(child);
      } else {
        content += inlineText(child);
      }
    }

    const itemLines = content.trim().split("\n");
    lines.push(`${indent}${marker}${itemLines[0] ?? ""}`);
    for (const extra of itemLines.slice(1)) {
      lines.push(`${indent}${" ".repeat(marker.length)}${extra}`);
    }
    for (const sub of nested) lines.push(listToText(sub, depth + 1));
  }

  return lines.join("\n");
}

function tableToText(table: HTMLElement): string {
  const rows: string[] = [];
  for (const row of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(row.children).map((cell) => inlineText(cell).trim());
    rows.push(cells.join(" | "));
  }
  return rows.join("\n");
}
