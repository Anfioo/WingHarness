// Any `.sql` file of the project opened in the database panel's own editor.
//
// codelet's text editor would open it as plain text; this provider claims the
// extension so the tab is the same SQL editor the database windows use — with a
// data source picker, Run, and the results dock below. Nothing is read here:
// the store loads the file with a change tag so a concurrent edit is refused
// rather than overwritten, and the host draws the editor over the blank frame
// the panel keeps.

import {
  defineExtension,
  type CustomReadonlyEditorProvider,
  type Extension,
  type WebviewPanel,
} from "codelet/extensions";

import { sqlFileTabId, useProjectDb } from "@/features/database/project/view-store";

/** The view type the manifest declares and the provider registers under. */
export const SQL_EDITOR_VIEW_TYPE = "app.sqlEditor";

export interface SqlEditorOptions {
  /** Already localized — codelet localizes a manifest's contributions, not its wording. */
  displayName: string;
  /**
   * Registers the panel with the activity extension, which owns the tab strip
   * sync. It must be called before the store learns about the tab, or the
   * activity extension creates a second panel for it.
   */
  adopt: (tabId: string, panel: WebviewPanel) => void;
}

export function createSqlEditorExtension(options: SqlEditorOptions): Extension {
  return defineExtension({
    manifest: {
      name: "app-sql-editor",
      contributes: {
        customEditors: [
          {
            viewType: SQL_EDITOR_VIEW_TYPE,
            displayName: options.displayName,
            selector: [{ filenamePattern: "**/*.sql" }],
          },
        ],
      },
    },
    activate(context, vscode) {
      const provider: CustomReadonlyEditorProvider = {
        // The document has no state of its own to restore: the text lives in the
        // project store, which is the side that can reach the backend.
        openCustomDocument: (uri) => ({ uri, dispose: () => {} }),
        resolveCustomEditor: (document, panel) => {
          const path = document.uri.path;
          options.adopt(sqlFileTabId(path), panel);
          void useProjectDb.getState().openSqlFile(path);
        },
      };
      context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(SQL_EDITOR_VIEW_TYPE, provider)
      );
    },
  });
}
