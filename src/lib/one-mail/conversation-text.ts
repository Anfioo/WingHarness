// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { compactMailBodyText } from "./mail-text";

/**
 * Plain-text reading of a message.
 *
 * The HTML part is usually the better text: senders put their paragraphs,
 * lists and line breaks there, while the plain part is often one long line.
 * This module walks the parsed body, drops hidden nodes, keeps link targets and
 * turns block elements into blank-line-separated paragraphs.
 */

const PARAGRAPH_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
]);

export interface ConversationTextLink {
  text: string;
  href: string;
}

export function conversationLinkUrl(value: string): string | undefined {
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function conversationHtmlToText(html: string, links?: ConversationTextLink[]): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("script, style, head, template, noscript, [hidden]")
    .forEach((element) => element.remove());
  document.body.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const style = element.style;
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      /mso-hide\s*:\s*all/i.test(element.getAttribute("style") || "")
    ) {
      element.remove();
    }
  });

  function read(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || "").replace(/[\uE000\uE001]/g, "").replace(/\s+/g, " ");
    }
    if (!(node instanceof Element)) return "";
    if (node.tagName === "BR") return "\n";
    const text = Array.from(node.childNodes, read).join("");
    if (!text.trim()) return "";
    if (node.tagName === "A" && links) {
      const href = conversationLinkUrl(node.getAttribute("href") || "");
      if (href) {
        // Keep link destinations separate while normalizing paragraph whitespace.
        const index = links.push({ text: text.trim(), href }) - 1;
        return `\uE000${index}\uE001`;
      }
    }
    if (node.tagName === "LI") return `\n• ${text.trim()}`;
    if (node.tagName === "TD" || node.tagName === "TH") return `${text.trim()} `;
    if (node.tagName === "TR") return `${text.trim()}\n`;
    if (node.tagName === "BLOCKQUOTE") {
      return `\n\n${text
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    }
    if (node.tagName === "PRE") {
      return `\n\n${(node.textContent || "").replace(/[\uE000\uE001]/g, "")}\n\n`;
    }
    return PARAGRAPH_TAGS.has(node.tagName) ? `\n\n${text.trim()}\n\n` : text;
  }

  return compactMailBodyText(read(document.body))
    .replace(/^[\t \u00a0]+$/gm, "")
    .replace(/ +([，。；：！？、])/g, "$1")
    .trim();
}

export function conversationTextParts(
  value: string,
  links: ConversationTextLink[] = []
): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  const pattern = /\uE000(\d+)\uE001|https?:\/\/[^\s<>"'\uE000\uE001，。；：！？、（）]+/gi;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset) parts.push({ text: value.slice(offset, match.index) });
    if (match[1] !== undefined) {
      parts.push(links[Number(match[1])] ?? { text: match[0] });
      offset = match.index + match[0].length;
      continue;
    }
    let url = match[0].replace(/[.,;:!?]+$/, "");
    while (url.endsWith(")") && url.split(")").length > url.split("(").length) {
      url = url.slice(0, -1);
    }
    parts.push({ text: url, href: conversationLinkUrl(url) });
    offset = match.index + url.length;
  }
  if (offset < value.length) parts.push({ text: value.slice(offset) });
  return parts;
}
