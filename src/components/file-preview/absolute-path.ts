/**
 * Joins a project root and a `/`-rooted path from the project tree.
 *
 * The tree and the editors spell paths with `/`; the backend commands take an
 * absolute Windows path. Only the separators are normalized — the root's own
 * form, `\\?\` prefix included, is left alone (`sp_inspect_file` canonicalizes
 * it). There is no `node:path` in the webview.
 */
export function absolutePath(root: string, path: string): string {
  return root.replace(/[\\/]+$/, "") + path.replace(/\//g, "\\");
}
