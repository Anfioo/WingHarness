import {
  defineExtension,
  type CustomReadonlyEditorProvider,
  type Extension,
} from "codelet/extensions";
import { useEditorTabs } from "@/lib/editor/editor-tabs";
import { engines } from "@/lib/space-preview/registry";

/**
 * The file preview, offered to the editors as a codelet extension.
 *
 * The notes and project workbenches edit text: every file a tab opens is read as a string,
 * so a `.docx` or a `.png` can only arrive as the placeholder the transport writes in place
 * of bytes. Declaring the engine registry's formats as `customEditors` hands those tabs to
 * this provider instead, and the host draws them with the same preview the File Preview
 * page and the standalone window use.
 *
 * Only what the text editor is worse at is claimed — an extension listed in
 * `TEXT_EXTENSIONS` keeps its text tab, so Markdown, JSON and source files stay editable.
 */

/** Extensions the text editor handles well; the preview never takes these over. */
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "xml",
  "toml",
  "txt",
  "log",
  "js",
  "ts",
  "tsx",
  "jsx",
  "css",
  "rs",
  "py",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "sql",
  "sh",
  "ps1",
  "html",
  "htm",
  "xhtml",
  "svg",
  "svgz",
  "csv",
  "tsv",
]);

/** Every viewer format that no text editor should be asked to open. */
function previewExtensions(): string[] {
  const extensions = new Set<string>();
  for (const engine of engines) {
    for (const extension of engine.extensions) {
      if (!TEXT_EXTENSIONS.has(extension)) extensions.add(extension);
    }
  }
  return [...extensions].sort();
}

/** The view type the manifest declares and the provider registers under. */
export const PREVIEW_VIEW_TYPE = "app.filePreview";

/**
 * @param displayName already localized — codelet localizes a manifest's contributions but
 *   not its wording, so the caller passes the string it wants read.
 */
export function createPreviewExtension(options: { displayName: string }): Extension {
  return defineExtension({
    manifest: {
      name: "app-file-preview",
      contributes: {
        customEditors: [
          {
            viewType: PREVIEW_VIEW_TYPE,
            displayName: options.displayName,
            // One pattern, alternation generated from the registry: a format added there
            // is claimed here without a second list to keep in step.
            selector: [{ filenamePattern: `**/*.{${previewExtensions().join(",")}}` }],
          },
        ],
      },
    },
    activate(context, vscode) {
      const provider: CustomReadonlyEditorProvider = {
        // Nothing is read here: the file has no editor state to restore, and the bytes are
        // fetched by the host, which is the side that can reach the backend.
        openCustomDocument: (uri) => ({ uri, dispose: () => {} }),
        resolveCustomEditor: (document, panel) => {
          const path = document.uri.path;
          const key = `preview:${path}`;
          const surface = { kind: "preview", path, name: panel.title } as const;
          // The provider's frame is a blank placeholder: a preview panel without an
          // `html` string draws no frame at all, and the host lays the viewer over it.
          panel.webview.html = "";
          const sync = () => {
            const tabs = useEditorTabs.getState();
            if (panel.visible) tabs.show(key, surface);
            else tabs.hide(key);
          };
          panel.onDidChangeViewState(sync);
          panel.onDidDispose(() => useEditorTabs.getState().hide(key));
          // The first show happens while the provider is still being resolved, before
          // this listener exists — the panel is already visible by now.
          sync();
        },
      };
      context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(PREVIEW_VIEW_TYPE, provider)
      );
    },
  });
}
