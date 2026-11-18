// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

/** Collapse the whitespace a mail body carries without losing its paragraphs. */
export function compactMailBodyText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/^(?:\t| |\u00a0|\u200b|\u200c|\u200d|\u2060|\ufeff)+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\s+$/g, "");
}
