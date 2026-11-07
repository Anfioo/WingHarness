// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

export const CELL_PREVIEW_LIMIT = 1000;

/** Bound text layout without changing the underlying value or splitting a surrogate pair. */
export function cellPreview(value: string): string {
  if (value.length <= CELL_PREVIEW_LIMIT) return value;
  let end = CELL_PREVIEW_LIMIT;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end) + "…";
}

/** Whether the value spans several lines (a single-line field would drop its line breaks). */
export const hasLineBreak = (value: string) => /[\r\n]/.test(value);
