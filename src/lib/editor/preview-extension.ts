import {
  defineExtension,
  type CustomReadonlyEditorProvider,
  type Extension,
} from "codelet/extensions";
import { viewerRegistry } from "@/lib/preview/viewers/registry";

/**
 * The file preview, offered to the editors as a codelet extension.
 *
 * The notes and project workbenches edit text: every file a tab opens is read as a string,
 * so a `.docx` or a `.png` can only arrive as the placeholder the transport writes in place
 * of bytes. Declaring the registry's binary formats as `customEditors` hands those tabs to
 * this provider instead, and the host draws them with the same viewer the File Preview page
 * uses.
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
  for (const viewer of viewerRegistry) {
    for (const extension of viewer.extensions) {
      if (!TEXT_EXTENSIONS.has(extension)) extensions.add(extension);
    }
  }
  return [...extensions].sort();
}

/** The view type the manifest declares and the provider registers under. */
export const PREVIEW_VIEW_TYPE = "app.filePreview";

export interface PreviewOpenEvent {
  /** `/`-rooted path in the working copy, as the workbench itself speaks it. */
  path: string;
  /** What the tab was named, for the loading state before the file is read. */
  name: string;
  /** Closes the tab, which is what disposes the panel and clears the overlay. */
  close: () => void;
}

/**
 * @param displayName already localized — codelet localizes a manifest's contributions but
 *   not its wording, so the caller passes the string it wants read.
 * @param onOpen called once per opened tab, after `openCustomDocument` has resolved.
 * @param onClose called when the tab goes away, however it was closed.
 */
export function createPreviewExtension(options: {
  displayName: string;
  onOpen: (event: PreviewOpenEvent) => void;
  onClose: (path: string) => void;
}): Extension {
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
          // The panel outlives this call and cleans its own emitter up on dispose, so the
          // listener is not something the context has to hold.
          panel.onDidDispose(() => options.onClose(path));
          options.onOpen({ path, name: panel.title, close: () => panel.dispose() });
        },
      };
      context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(PREVIEW_VIEW_TYPE, provider)
      );
    },
  });
}
