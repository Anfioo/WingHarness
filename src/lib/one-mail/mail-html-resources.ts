// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

/**
 * Attribute and URL predicates shared by the message HTML preparer.
 *
 * These helpers make no decisions on their own: they answer whether a scheme,
 * a srcset candidate or a style declaration may be kept, so the preparer can
 * block a remote resource without losing the element that referenced it.
 */
export const resourceAttributes = ["src", "srcset", "poster", "background"] as const;

export type ResourceAttribute = (typeof resourceAttributes)[number];

/** The attribute a blocked resource value is parked under, so it can come back. */
export function toBlockedAttribute(attribute: string): string {
  return `data-blocked-${attribute}`;
}

export function isSafeHref(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return true;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

export function isSafeResourceValue(attribute: ResourceAttribute, value: string): boolean {
  if (attribute === "srcset") return isSafeSrcset(value);
  return isSafeResourceUrl(value);
}

export function normalizeRestoredResourceValue(
  attribute: ResourceAttribute,
  value: string
): string {
  if (attribute === "srcset") return normalizeRestoredSrcset(value);
  return normalizeRestoredResourceUrl(value);
}

function normalizeRestoredSrcset(value: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = parts[0];
      if (!url) return "";
      return [normalizeRestoredResourceUrl(url), ...parts.slice(1)].join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function normalizeRestoredResourceUrl(value: string): string {
  const trimmed = value.trim();
  if (!looksLikeHostnameRelativeUrl(trimmed)) return value;
  return `https://${trimmed}`;
}

function looksLikeHostnameRelativeUrl(value: string): boolean {
  if (!value || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;

  const firstSegment = value.split(/[/?#]/, 1)[0];
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i.test(firstSegment);
}

function isSafeSrcset(value: string): boolean {
  if (/^\s*data:/i.test(value)) return false;

  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean)
    .every(isSafeResourceUrl);
}

export function isSafeResourceUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\/\//.test(trimmed)) return true;
  if (/^https?:/i.test(trimmed)) return true;
  if (/^cid:/i.test(trimmed)) return true;
  if (/^data:image\/(avif|bmp|gif|jpeg|jpg|png|webp);base64,/i.test(trimmed)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

export function isSafeStyle(value: string): boolean {
  return !/(javascript\s*:|expression\s*\(|behavior\s*:|-moz-binding\s*:)/i.test(value);
}

export function styleLoadsResource(value: string): boolean {
  return /(url\s*\(|@import)/i.test(value);
}
