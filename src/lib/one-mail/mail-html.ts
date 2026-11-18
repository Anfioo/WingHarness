// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import {
  isSafeHref,
  isSafeResourceUrl,
  isSafeResourceValue,
  isSafeStyle,
  normalizeRestoredResourceValue,
  resourceAttributes,
  styleLoadsResource,
  toBlockedAttribute,
  type ResourceAttribute,
} from "./mail-html-resources";

/**
 * Turn a message's raw HTML into markup that is safe to render and still looks
 * like the sender laid it out.
 *
 * The pass keeps tables, fonts, colours, padding and most inline styles, and
 * drops only what can escape the bubble: scripts, frames, forms, unsafe links
 * and layout-breaking declarations such as `position`, `float` and transforms.
 * Remote resources are disabled by default and parked under `data-blocked-*`
 * attributes, so a per-message opt-in can bring them back without another
 * round trip to the server.
 */
export interface PreparedMailHtml {
  html: string;
  blockedResourceCount: number;
  blockedImageResourceCount: number;
  removedUnsafeElementCount: number;
}

export interface PrepareMailHtmlOptions {
  allowExternalImages: boolean;
}

const REMOVED_ELEMENT_SELECTOR = [
  "script",
  "style",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "svg",
  "math",
].join(",");

const BLOCKED_RESOURCE_ONLY_CONTAINER_SELECTOR = [
  "a",
  "span",
  "p",
  "div",
  "center",
  "section",
  "article",
  "td",
  "th",
  "tr",
  "tbody",
  "thead",
  "tfoot",
  "table",
].join(",");

/**
 * Declarations that move an element out of the mail flow. Everything else —
 * including widths, padding, borders and font sizes — is the sender's layout
 * and stays.
 */
const LAYOUT_BREAKING_STYLE_PROPERTIES = new Set([
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "inset-block",
  "inset-block-start",
  "inset-block-end",
  "inset-inline",
  "inset-inline-start",
  "inset-inline-end",
  "z-index",
  "float",
  "transform",
  "translate",
  "scale",
  "rotate",
  "filter",
  "backdrop-filter",
  "clip",
  "clip-path",
]);

interface Counters {
  blockedResourceCount: number;
  blockedImageResourceCount: number;
  removedUnsafeElementCount: number;
}

export function prepareMailHtml(
  html: string,
  { allowExternalImages }: PrepareMailHtmlOptions
): PreparedMailHtml {
  const document = new DOMParser().parseFromString(html, "text/html");
  const counters: Counters = {
    blockedResourceCount: 0,
    blockedImageResourceCount: 0,
    removedUnsafeElementCount: 0,
  };

  for (const element of Array.from(document.body.querySelectorAll(REMOVED_ELEMENT_SELECTOR))) {
    counters.removedUnsafeElementCount += 1;
    element.remove();
  }

  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    sanitizeAttributes(element, allowExternalImages, counters);
  }

  if (!allowExternalImages) {
    markBlockedResourceOnlyContainers(document.body);
  } else {
    for (const element of Array.from(document.body.querySelectorAll("[data-mail-blocked-only]"))) {
      element.removeAttribute("data-mail-blocked-only");
    }
  }

  return {
    html: document.body.innerHTML,
    ...counters,
  };
}

function sanitizeAttributes(
  element: Element,
  allowExternalImages: boolean,
  counters: Counters
): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();

    if (name.startsWith("on") || name === "srcdoc" || name === "ping") {
      element.removeAttribute(attribute.name);
      continue;
    }

    if ((name === "href" || name.endsWith(":href")) && !isSafeHref(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }

  for (const attribute of resourceAttributes) {
    sanitizeResourceAttribute(element, attribute, allowExternalImages, counters);
  }

  sanitizeStyleAttribute(element, allowExternalImages, counters);
  hardenLinks(element);
}

function sanitizeResourceAttribute(
  element: Element,
  attribute: ResourceAttribute,
  allowExternalImages: boolean,
  counters: Counters
): void {
  const blockedAttribute = toBlockedAttribute(attribute);
  const blockedValue = element.getAttribute(blockedAttribute);

  if (
    blockedValue &&
    allowExternalImages &&
    canRestoreImageResource(element, attribute) &&
    isSafeResourceValue(attribute, normalizeRestoredResourceValue(attribute, blockedValue))
  ) {
    element.setAttribute(attribute, normalizeRestoredResourceValue(attribute, blockedValue));
    element.removeAttribute(blockedAttribute);
    element.removeAttribute("data-mail-blocked-resource");
    hardenImageElement(element);
    return;
  }

  const value = element.getAttribute(attribute);
  const shouldBlock =
    Boolean(value) &&
    (!allowExternalImages ||
      !canRestoreImageResource(element, attribute) ||
      !isSafeResourceValue(attribute, value ?? ""));

  if (shouldBlock) {
    rememberBlockedResource(element, attribute, counters);
    return;
  }

  if (blockedValue) {
    counters.blockedResourceCount += 1;
    if (canRestoreImageResource(element, attribute)) {
      counters.blockedImageResourceCount += 1;
    }
    markBlockedResource(element, attribute);
  }

  if (value) hardenImageElement(element);
}

function sanitizeStyleAttribute(
  element: Element,
  allowExternalImages: boolean,
  counters: Counters
): void {
  const blockedStyle = element.getAttribute("data-blocked-style");
  const inlineStyle = element.getAttribute("style");
  const style = inlineStyle ?? (allowExternalImages ? blockedStyle : null);

  if (!style) {
    if (blockedStyle) {
      counters.blockedResourceCount += 1;
      counters.blockedImageResourceCount += 1;
      element.setAttribute("data-mail-blocked-resource", "true");
    }
    return;
  }

  if (!isSafeStyle(style)) {
    element.removeAttribute("style");
    element.removeAttribute("data-blocked-style");
    element.removeAttribute("data-mail-blocked-resource");
    return;
  }

  const sanitized = sanitizeStyleDeclarations(element, style, allowExternalImages);

  if (sanitized.blockedResource) {
    element.setAttribute("data-blocked-style", style);
    element.removeAttribute("style");
    element.setAttribute("data-mail-blocked-resource", "true");
    counters.blockedResourceCount += 1;
    counters.blockedImageResourceCount += 1;
    return;
  }

  if (sanitized.style) {
    element.setAttribute("style", sanitized.style);
  } else {
    element.removeAttribute("style");
  }

  if (allowExternalImages) {
    element.removeAttribute("data-blocked-style");
    element.removeAttribute("data-mail-blocked-resource");
  }
}

function sanitizeStyleDeclarations(
  element: Element,
  value: string,
  allowExternalImages: boolean
): { style: string; blockedResource: boolean } {
  const scratch = element.ownerDocument.createElement("span");
  scratch.setAttribute("style", value);

  const declarations: string[] = [];
  let blockedResource = false;

  for (const property of Array.from({ length: scratch.style.length }, (_, index) =>
    scratch.style.item(index)
  )) {
    const name = property.toLowerCase();
    const propertyValue = scratch.style.getPropertyValue(property).trim();

    if (!propertyValue || shouldDropStyleProperty(name, propertyValue)) continue;

    if (styleLoadsResource(`${name}: ${propertyValue}`)) {
      if (!allowExternalImages) {
        blockedResource = true;
        continue;
      }

      if (!styleResourceUrlsAreSafe(propertyValue)) continue;
    }

    declarations.push(`${name}: ${propertyValue}`);
  }

  return {
    style: declarations.join("; "),
    blockedResource,
  };
}

function shouldDropStyleProperty(name: string, value: string): boolean {
  if (LAYOUT_BREAKING_STYLE_PROPERTIES.has(name)) return true;
  if (name.startsWith("animation") || name.startsWith("transition")) return true;
  if ((name === "margin" || name.startsWith("margin-")) && hasNegativeCssLength(value)) {
    return true;
  }
  if ((name === "text-indent" || name === "letter-spacing") && hasNegativeCssLength(value)) {
    return true;
  }
  if (name === "line-height" && isCollapsedLineHeight(value)) return true;
  return false;
}

function hasNegativeCssLength(value: string): boolean {
  return /(^|[\s(])-((?:\d*\.)?\d+)(px|pt|em|rem|%|vh|vw|vmin|vmax|cm|mm|in|pc|ch|ex|lh|rlh)\b/i.test(
    value
  );
}

function isCollapsedLineHeight(value: string): boolean {
  return /^0(?:\.0+)?(?:px|pt|em|rem|%|vh|vw|vmin|vmax|cm|mm|in|pc|ch|ex|lh|rlh)?$/i.test(
    value.trim()
  );
}

function styleResourceUrlsAreSafe(value: string): boolean {
  return Array.from(value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)).every((match) =>
    isSafeResourceUrl(match[2] ?? "")
  );
}

function markBlockedResourceOnlyContainers(root: HTMLElement): void {
  const candidates = Array.from(
    root.querySelectorAll(BLOCKED_RESOURCE_ONLY_CONTAINER_SELECTOR)
  ).reverse();

  for (const element of candidates) {
    if (isBlockedResourceOnlyElement(element)) {
      element.setAttribute("data-mail-blocked-only", "true");
    }
  }
}

function isBlockedResourceOnlyElement(element: Element): boolean {
  let hasBlockedResource = false;

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent?.trim()) return false;
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const childElement = child as Element;

    if (isBlockedResourcePlaceholder(childElement)) {
      hasBlockedResource = true;
      continue;
    }

    if (childElement.getAttribute("data-mail-blocked-only") === "true") {
      hasBlockedResource = true;
      continue;
    }

    if (isEmptyLayoutElement(childElement)) continue;

    return false;
  }

  return hasBlockedResource;
}

function isBlockedResourcePlaceholder(element: Element): boolean {
  return (
    element.getAttribute("data-mail-blocked-resource") === "true" &&
    !element.getAttribute("src") &&
    !element.getAttribute("srcset")
  );
}

function isEmptyLayoutElement(element: Element): boolean {
  return !element.textContent?.trim() && element.children.length === 0;
}

function rememberBlockedResource(
  element: Element,
  attribute: ResourceAttribute,
  counters: Counters
): void {
  const blockedAttribute = toBlockedAttribute(attribute);
  const value = element.getAttribute(attribute);

  if (value && !element.hasAttribute(blockedAttribute)) {
    element.setAttribute(blockedAttribute, value);
  }

  element.removeAttribute(attribute);
  counters.blockedResourceCount += 1;

  if (canRestoreImageResource(element, attribute)) {
    counters.blockedImageResourceCount += 1;
    markBlockedResource(element, attribute);
  }
}

function markBlockedResource(element: Element, attribute: ResourceAttribute): void {
  if (canRestoreImageResource(element, attribute)) {
    element.setAttribute("data-mail-blocked-resource", "true");
  }
}

function canRestoreImageResource(element: Element, attribute: ResourceAttribute): boolean {
  const tagName = element.tagName.toLowerCase();

  if (attribute === "background") return true;
  if (tagName === "img" && (attribute === "src" || attribute === "srcset")) return true;
  if (tagName === "source" && attribute === "srcset") {
    return element.parentElement?.tagName.toLowerCase() === "picture";
  }

  return false;
}

function hardenImageElement(element: Element): void {
  if (element.tagName.toLowerCase() !== "img") return;

  element.setAttribute("loading", "lazy");
  element.setAttribute("decoding", "async");
  element.setAttribute("referrerpolicy", "no-referrer");
}

function hardenLinks(element: Element): void {
  if (element.tagName.toLowerCase() !== "a" || !element.getAttribute("href")) return;

  element.setAttribute("target", "_blank");
  element.setAttribute("rel", "noopener noreferrer nofollow");
}
