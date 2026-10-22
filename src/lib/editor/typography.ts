import { DEFAULT_FONT_FAMILY, loadEditorPrefs, type EditorPrefs } from "./prefs";

/**
 * Every element that wraps an editor — a workbench or a standalone `Editor` —
 * carries this class, so one rule reaches all of them regardless of which
 * codelet surface mounted it.
 */
export const EDITOR_SURFACE_CLASS = "editor-surface";

/**
 * Codelet hardcodes the editor's font as an inline style and exposes no option
 * to change it, so typography is applied by overriding it with CSS. An inline
 * style loses to an `!important` rule, which is what makes this possible
 * without patching the library.
 *
 * Only the editor's own text is restyled — the chrome around it (file tree,
 * tabs, panel) keeps codelet's sizing, matching how an editor font size is
 * separate from a window zoom level.
 */
const STYLE_ID = "editor-typography";

/**
 * Keeps only the characters a font stack can legitimately contain.
 *
 * A blacklist would leave escapes open — a `/*` hides the rest of a rule and an
 * unbalanced quote swallows it — so this allows the safe set instead: letters,
 * digits, spaces, commas, quotes and the punctuation font names actually use.
 * A font the filter damages simply falls back to the default.
 */
function sanitizeFamily(family: string): string {
  return family.replace(/[^\p{L}\p{N}\s,'"_-]/gu, "").trim();
}

/**
 * Builds the stylesheet for the given preferences, scoped to `scope`.
 *
 * Exported for the settings preview, which renders it against the draft it is
 * editing rather than against what is already on disk.
 */
export function editorTypographyCss(prefs: EditorPrefs, scope?: string): string {
  const family = sanitizeFamily(prefs.fontFamily) || DEFAULT_FONT_FAMILY;
  const root = scope ?? `.${EDITOR_SURFACE_CLASS}`;
  const rules = [
    `${root} .cm-scroller {`,
    `  font-family: ${family} !important;`,
    `  font-size: ${prefs.fontSize}px !important;`,
    `  line-height: ${prefs.lineHeight} !important;`,
    `}`,
  ];
  // The gutter is inside the scroller and inherits its size, so hiding the
  // line-number column is all this needs — the fold arrows stay.
  if (!prefs.lineNumbers) {
    rules.push(`${root} .cm-gutters .cm-lineNumbers { display: none !important; }`);
  }
  return rules.join("\n");
}

/**
 * Injects or updates the page-wide override stylesheet.
 *
 * `scope` and `id` are for a caller that needs its own copy — the settings page
 * previews a draft there without disturbing what the pages on disk are using.
 */
export function applyEditorTypography(
  prefs: EditorPrefs = loadEditorPrefs(),
  options: { scope?: string; id?: string } = {}
): void {
  const id = options.id ?? STYLE_ID;
  const css = editorTypographyCss(prefs, options.scope);
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.appendChild(style);
  }
  if (style.textContent === css) return;
  style.textContent = css;

  // CodeMirror caches character and line metrics measured from the DOM. Left to
  // itself it re-measures on a container resize; a font change resizes the text
  // without always resizing the box, so nudge it with the same signal it already
  // listens for — otherwise cursors and clicks drift from the text.
  window.dispatchEvent(new Event("resize"));
}
