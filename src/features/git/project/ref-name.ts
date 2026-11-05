const FORBIDDEN = "~^:?*[\\";

function hasIllegalCharacter(name: string): boolean {
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
    if (/\s/.test(char)) return true;
    if (FORBIDDEN.includes(char)) return true;
  }
  return false;
}

/** The subset of `git check-ref-format` rules a branch or tag name must follow. */
export function isValidRefName(name: string): boolean {
  if (name.length === 0 || name === "@") return false;
  if (hasIllegalCharacter(name)) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return name
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
