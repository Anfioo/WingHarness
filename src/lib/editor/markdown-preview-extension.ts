import { defineExtension, Uri, ViewColumn } from "codelet/extensions";
import type { Extension, TextDocument, WebviewPanel } from "codelet/extensions";
import { useEditorTabs, type EditorTabSurface } from "@/lib/editor/editor-tabs";
import { useMarkdownPreviewDocs } from "@/lib/editor/markdown-preview-docs";

/**
 * The Markdown reading tab, rendered by the app instead of by codelet.
 *
 * codelet's own `markdownPreview` fetches `md4x` and its `.wasm` from `esm.sh`
 * at runtime, so a preview needs the network. This extension keeps the same two
 * commands and menus — "Open Preview" beside the text, "Open Source" back to it
 * — but opens a blank webview panel that the host covers with the Markdown
 * editor's own renderer (`renderMarkdown` + `PreviewPane` + `OutlinePanel`).
 * Editing is untouched: a `.md` still opens in codelet's text editor, and this
 * is only the reading half.
 */

export const MARKDOWN_PREVIEW_VIEW_TYPE = "app.markdownPreview";
/** codelet's own command ids, so the menus and any binding keep pointing here. */
const SHOW_PREVIEW = "markdown.showPreview";
const SHOW_SOURCE = "markdown.showSource";
const LANGUAGE = "markdown";

interface OpenPreview {
  panel: WebviewPanel;
  document: TextDocument;
  surface: EditorTabSurface;
}

export function createMarkdownPreviewExtension(): Extension {
  return defineExtension({
    manifest: {
      name: "app-markdown-preview",
      contributes: {
        commands: [
          {
            command: SHOW_PREVIEW,
            title: "Open Preview",
            category: "Markdown",
            icon: "preview",
          },
          {
            command: SHOW_SOURCE,
            title: "Open Source",
            category: "Markdown",
            icon: "file",
          },
        ],
        menus: {
          "editor/title": [
            {
              command: SHOW_PREVIEW,
              when: "editorLangId == markdown",
              group: "navigation",
            },
            {
              command: SHOW_SOURCE,
              when: `activeWebviewPanelId == ${MARKDOWN_PREVIEW_VIEW_TYPE}`,
              group: "navigation",
            },
          ],
          "explorer/context": [
            { command: SHOW_PREVIEW, when: "resourceLangId == markdown", group: "navigation" },
          ],
          "editor/title/context": [
            { command: SHOW_PREVIEW, when: "resourceLangId == markdown", group: "navigation" },
          ],
        },
      },
    },
    activate(context, vscode) {
      const panels = new Map<string, OpenPreview>();

      const showPreview = async (target?: unknown) => {
        const document = target
          ? await vscode.workspace.openTextDocument(target as Uri)
          : vscode.window.activeTextEditor?.document;
        if (!document || document.languageId !== LANGUAGE) return;

        const path = document.uri.path;
        const key = keyOf(path);
        const existing = panels.get(path);
        if (existing) {
          existing.document = document;
          useMarkdownPreviewDocs.getState().set(path, document.getText());
          existing.panel.reveal();
          // `reveal()` may return without a visibility event; the surface is
          // known already, so mark it showing right away.
          useEditorTabs.getState().show(key, existing.surface);
          return;
        }

        const panel = vscode.window.createWebviewPanel(
          MARKDOWN_PREVIEW_VIEW_TYPE,
          `Preview ${basename(path)}`,
          ViewColumn.Beside,
          { enableScripts: false }
        );
        const opened: OpenPreview = {
          panel,
          document,
          surface: { kind: "markdown", path, name: basename(path) },
        };
        panels.set(path, opened);
        useMarkdownPreviewDocs.getState().set(path, document.getText());
        // An empty string, not leaving it unset: codelet draws no frame while
        // `html` is undefined, and the host needs one to measure the area to cover.
        panel.webview.html = "";

        const sync = () => {
          const tabs = useEditorTabs.getState();
          if (panel.visible) tabs.show(key, opened.surface);
          else tabs.hide(key);
        };
        panel.onDidChangeViewState(sync);
        panel.onDidDispose(() => {
          if (panels.get(path) === opened) panels.delete(path);
          useMarkdownPreviewDocs.getState().remove(path);
          useEditorTabs.getState().hide(key);
        });
        // A tab created as the active one does not report a visibility change:
        // it was already visible before the listener existed.
        sync();
      };

      const showSource = async () => {
        const visible = Array.from(panels.values()).find((entry) => entry.panel.visible);
        if (!visible) return;
        await vscode.window.showTextDocument(visible.document.uri);
      };

      const changed = vscode.workspace.onDidChangeTextDocument(({ document }) => {
        if (document.languageId !== LANGUAGE) return;
        const path = document.uri.path;
        const entry = panels.get(path);
        if (!entry) return;
        // The document object is replaced on reload; "Open Source" must open the
        // one the preview is showing.
        entry.document = document;
        useMarkdownPreviewDocs.getState().set(path, document.getText());
      });

      context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_PREVIEW, (target?: unknown) => showPreview(target)),
        vscode.commands.registerCommand(SHOW_SOURCE, () => showSource()),
        changed,
        {
          dispose() {
            // Closing them here rather than only dropping the map: the preview is
            // the reading half of a document, and a workbench rebuild would
            // otherwise leave tab strips pointing at a surface nobody draws.
            for (const { panel } of Array.from(panels.values())) panel.dispose();
            panels.clear();
            useMarkdownPreviewDocs.getState().reset();
          },
        }
      );
    },
  });
}

function keyOf(path: string): string {
  return `markdown:${path}`;
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}
