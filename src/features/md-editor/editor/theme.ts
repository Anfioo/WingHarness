import { EditorView } from "@codemirror/view";

/**
 * Neutral editor chrome. The app theme (light/dark and the theme presets) is
 * wired in the final phase; until then the editor borrows the app's CSS
 * variables so it does not look out of place, without owning any colours of
 * its own.
 */
export const mdEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "var(--md-editor-font-size, 14px)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily:
      "var(--md-editor-font-family, var(--font-mono, ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, monospace))",
    lineHeight: "var(--md-editor-line-height, 1.7)",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "12px 0",
    caretColor: "var(--foreground)",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 24%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--primary) 18%, transparent)",
    outline: "1px solid color-mix(in oklab, var(--primary) 40%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--primary) 32%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    borderColor: "var(--border)",
  },
  ".cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
});
