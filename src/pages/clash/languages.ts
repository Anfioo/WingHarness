/**
 * Clash sources are YAML; a file with another extension gets plain text.
 *
 * `null` is the editor's word for "no grammar" — highlight.js has no plain-text
 * language to name.
 */
export function languageFor(filename: string): string | null {
  const name = filename.toLowerCase();
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  return name.includes(".") ? null : "yaml";
}
