// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useMemo, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The message body's HTML preview.
 *
 * Every string that reaches `dangerouslySetInnerHTML` goes through
 * `DOMPurify.sanitize` first and then through the attribute pass below: scripts,
 * frames, forms, SVG and MathML are removed, links are limited to http / https /
 * mailto, inline styles keep only typographic declarations, and remote images
 * are replaced by a placeholder until the reader asks for them — per message,
 * never as a write-back to the settings.
 */

const FORBID_TAGS = [
  "script",
  "style",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "svg",
  "math",
  "template",
  "noscript",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
];

const FORBID_ATTR = [
  "srcset",
  "poster",
  "srcdoc",
  "ping",
  "formaction",
  "xlink:href",
  "class",
  "id",
];

/** Inline styles are the only styles an email may keep, and only these. */
const ALLOWED_STYLE_PROPERTIES = new Set([
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "text-decoration",
  "text-align",
  "white-space",
]);

const SAFE_HREF = /^(?:https?:|mailto:)/i;
const REMOTE_RESOURCE = /^(?:https?:)?\/\//i;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i;

const BLOCKED_PLACEHOLDER_STYLE =
  "display:inline-block;min-width:1.5rem;min-height:1.5rem;border:1px dashed rgba(127,127,127,0.45);border-radius:4px;background:rgba(127,127,127,0.08);vertical-align:middle;";

/**
 * The prose rules the sanitized body is rendered under. The project has no
 * typography plugin, so the handful of element styles an email needs are
 * spelled out as child selectors on the container.
 */
const BODY_CLASSES = [
  "text-sm leading-relaxed break-words [overflow-wrap:anywhere]",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3",
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold",
  "[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_hr]:border-border [&_hr]:my-3",
  "[&_img]:my-1 [&_img]:max-w-full [&_img]:rounded",
  "[&_li]:my-0.5",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_p]:my-1.5",
  "[&_pre]:bg-muted [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-xs",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse",
  "[&_td]:border-border [&_td]:border [&_td]:px-2 [&_td]:py-1",
  "[&_th]:border-border [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
].join(" ");

interface PreparedHtml {
  /** Sanitized markup: the only string this module ever sets as HTML. */
  html: string;
  blockedImages: number;
}

export interface MessageHtmlProps {
  html: string;
  /** `true` keeps remote image URLs; `false` swaps them for placeholders. */
  allowExternalImages: boolean;
  onLoadExternalImages: () => void;
}

/**
 * Sanitize the body and apply the resource policy.
 *
 * The email is parsed into an inert `<template>`, so nothing in it can load or
 * run while the attribute pass rewrites it.
 */
function prepareHtml(html: string, allowExternalImages: boolean): PreparedHtml {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
  });

  const template = document.createElement("template");
  template.innerHTML = sanitized;
  const root = template.content;
  let blockedImages = 0;

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const style = element.getAttribute("style");
    const filtered = style ? filterStyle(style) : "";
    if (filtered) element.setAttribute("style", filtered);
    else element.removeAttribute("style");

    const background = element.getAttribute("background");
    if (background) {
      element.removeAttribute("background");
      if (!allowExternalImages && REMOTE_RESOURCE.test(background)) blockedImages += 1;
    }

    if (element.tagName === "IMG") {
      blockedImages += applyImagePolicy(element as HTMLImageElement, allowExternalImages);
    } else if (element.tagName === "A") {
      hardenAnchor(element as HTMLAnchorElement);
    }
  }

  return { html: template.innerHTML, blockedImages };
}

/** Keep the typographic declarations, drop everything that could move the page. */
function filterStyle(value: string): string {
  const probe = document.createElement("span");
  probe.setAttribute("style", value);

  const declarations: string[] = [];
  for (let index = 0; index < probe.style.length; index += 1) {
    const property = probe.style.item(index).toLowerCase();
    const propertyValue = probe.style.getPropertyValue(property).trim();
    if (!ALLOWED_STYLE_PROPERTIES.has(property) || !propertyValue) continue;
    if (/url\s*\(|expression|javascript:/i.test(propertyValue)) continue;
    declarations.push(`${property}: ${propertyValue}`);
  }
  return declarations.join("; ");
}

/**
 * A remote image becomes a dashed placeholder until the reader opts in; data
 * images and everything else that is not a remote URL are handled locally.
 * Returns the number of blocked remote images.
 */
function applyImagePolicy(image: HTMLImageElement, allowExternalImages: boolean): number {
  const src = image.getAttribute("src")?.trim() ?? "";

  if (!src) {
    image.removeAttribute("src");
    return 0;
  }

  if (DATA_IMAGE.test(src)) {
    hardenImage(image);
    return 0;
  }

  if (!REMOTE_RESOURCE.test(src)) {
    // cid: attachments are not downloaded, and no other scheme is allowed.
    image.removeAttribute("src");
    return 0;
  }

  if (allowExternalImages) {
    hardenImage(image);
    return 0;
  }

  const placeholder = document.createElement("span");
  placeholder.setAttribute("data-one-mail-blocked", "true");
  placeholder.setAttribute("aria-hidden", "true");
  const width = image.getAttribute("width");
  const height = image.getAttribute("height");
  const widthRule = width && /^\d+$/.test(width) ? `width:${Math.min(Number(width), 640)}px;` : "";
  const heightRule =
    height && /^\d+$/.test(height) ? `height:${Math.min(Number(height), 480)}px;` : "";
  placeholder.setAttribute("style", `${widthRule}${heightRule}${BLOCKED_PLACEHOLDER_STYLE}`);
  image.replaceWith(placeholder);
  return 1;
}

function hardenImage(image: HTMLImageElement): void {
  image.setAttribute("loading", "lazy");
  image.setAttribute("decoding", "async");
  image.setAttribute("referrerpolicy", "no-referrer");
}

function hardenAnchor(anchor: HTMLAnchorElement): void {
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!SAFE_HREF.test(href)) {
    anchor.removeAttribute("href");
    return;
  }
  anchor.setAttribute("target", "_blank");
  anchor.setAttribute("rel", "noopener noreferrer nofollow");
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
  if (!SAFE_HREF.test(href)) return;
  void openUrl(href).catch(() => undefined);
}

export default function MessageHtml({
  html,
  allowExternalImages,
  onLoadExternalImages,
}: MessageHtmlProps) {
  const { t } = useAppTranslation();
  const prepared = useMemo(
    () => (html ? prepareHtml(html, allowExternalImages) : null),
    [html, allowExternalImages]
  );

  if (!prepared) return null;

  const showBlockedNotice = !allowExternalImages && prepared.blockedImages > 0;

  return (
    <div className="space-y-2">
      <div
        className={BODY_CLASSES}
        onClick={handleLinkClick}
        // `prepared.html` is the sanitized output of `prepareHtml`.
        dangerouslySetInnerHTML={{ __html: prepared.html }}
      />
      {showBlockedNotice && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span>{t("oneMail.thread.remoteImagesBlocked", { count: prepared.blockedImages })}</span>
          <Button type="button" variant="outline" size="xs" onClick={onLoadExternalImages}>
            {t("oneMail.thread.loadRemoteImages")}
          </Button>
        </div>
      )}
    </div>
  );
}
