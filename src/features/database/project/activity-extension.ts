// The database button on the project page's activity bar, and the editor tabs
// behind it.
//
// The button covers the file tree with the project's data sources — the panel
// itself is React, laid over the side bar by `WorkbenchSurface`. A query file,
// a project `.sql` file and a table's data are real codelet tabs, because that
// is what gives them a tab strip and a place in the editor area; each is a
// blank panel with the React view drawn over it.
//
// The `.sql` provider in `sql-extension.ts` opens the same kind of panel, so
// both go through one registry here: a panel the provider made is adopted with
// `adopt()` rather than created a second time.

import { defineExtension, ViewColumn, type Extension, type WebviewPanel } from "codelet/extensions";

import { useGitView } from "@/features/git/project/git-view-store";
import { useProjectDb, type ProjectDbTab } from "@/features/database/project/view-store";
import { DATABASE_ICON, attachActivityButtons } from "@/lib/editor/activity-buttons";
import { useEditorTabs, type EditorTabSurface } from "@/lib/editor/editor-tabs";

const CONTAINER_ID = "app.projectDb.panel";
const PANEL_VIEW_TYPE = "app.projectDbTab";
/** VSCode's own command for revealing a contributed view container. */
const OPEN_COMMAND = `workbench.view.extension.${CONTAINER_ID}`;

interface ActivationApi {
  window: {
    createWebviewPanel: (
      viewType: string,
      title: string,
      showOptions: ViewColumn,
      options?: { enableScripts?: boolean }
    ) => WebviewPanel;
  };
  commands: {
    registerCommand: (
      command: string,
      callback: (...args: unknown[]) => unknown
    ) => { dispose(): void };
  };
}

interface OpenPanel {
  panel: WebviewPanel;
  surface: EditorTabSurface;
}

export interface ProjectDbActivityOptions {
  /** The element the workbench was mounted into; the activity bar lives inside it. */
  parent: HTMLElement;
  /** The button's label, already localized. */
  label: string;
  /** Title a host-drawn tab carries, already localized. */
  title: (tab: ProjectDbTab) => string;
}

export interface ProjectDbActivityHandle {
  extension: Extension;
  /**
   * Registers a panel the `.sql` provider made. `resolveCustomEditor` calls
   * this before the store knows about the tab, so the sync below leaves it
   * alone until the tab appears.
   */
  adopt: (tabId: string, panel: WebviewPanel) => void;
}

export function createProjectDbActivityExtension(
  options: ProjectDbActivityOptions
): ProjectDbActivityHandle {
  let api: ActivationApi | null = null;
  const panels = new Map<string, OpenPanel>();
  /** The tab ids the store held at the last sync. */
  let known = new Set<string>();

  const surfaceOf = (tabId: string): EditorTabSurface => ({ kind: "dbTab", tabId });

  /** Keeps the host's overlay in step with the panel codelet says is visible. */
  const watch = (tabId: string, panel: WebviewPanel) => {
    panel.onDidChangeViewState(() => {
      const tabs = useEditorTabs.getState();
      if (!panel.visible) {
        tabs.hide(`projectDb:${tabId}`);
        return;
      }
      tabs.show(`projectDb:${tabId}`, surfaceOf(tabId));
      // Clicking a tab in codelet's strip is what selects it here; reveal()
      // causes the same event, so only a real change is recorded.
      const state = useProjectDb.getState();
      if (state.active !== tabId) state.select(tabId);
    });
    panel.onDidDispose(() => {
      if (panels.get(tabId)?.panel === panel) panels.delete(tabId);
      useEditorTabs.getState().hide(`projectDb:${tabId}`);
      useProjectDb.getState().close(tabId);
    });
  };

  const create = (tab: ProjectDbTab) => {
    if (!api) return;
    const panel = api.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      options.title(tab),
      ViewColumn.One,
      { enableScripts: false }
    );
    // An empty string, not leaving it unset: codelet draws no frame while
    // `html` is undefined, and the host needs one to measure the area to cover.
    panel.webview.html = "";
    panels.set(tab.id, { panel, surface: surfaceOf(tab.id) });
    watch(tab.id, panel);
  };

  const sync = () => {
    const state = useProjectDb.getState();
    const current = new Set(state.tabs.map((tab) => tab.id));

    // A panel the `.sql` provider adopted exists before its tab does; only a
    // tab that was there and is now gone closes its panel.
    for (const [tabId, entry] of [...panels]) {
      if (current.has(tabId) || !known.has(tabId)) continue;
      panels.delete(tabId);
      entry.panel.dispose();
    }

    for (const tab of state.tabs) {
      if (!panels.has(tab.id)) create(tab);
    }

    const active = panels.get(state.active ?? "");
    if (active && !active.panel.visible) active.panel.reveal();
    known = current;
  };

  const extension = defineExtension({
    manifest: {
      name: "app-project-db-activity",
      contributes: {
        viewsContainers: {
          activitybar: [{ id: CONTAINER_ID, title: options.label, icon: "activity" }],
        },
        views: {},
      },
    },
    activate(context, vscode) {
      api = vscode as unknown as ActivationApi;

      context.subscriptions.push(
        api.commands.registerCommand(OPEN_COMMAND, () => {
          useGitView.getState().closeChanges();
          useProjectDb.getState().togglePanel();
        })
      );

      const button = attachActivityButtons({
        parent: options.parent,
        buttons: [
          {
            label: options.label,
            icon: DATABASE_ICON,
            isActive: () => useProjectDb.getState().panelOpen,
            onActivate: () => {
              // The Git buttons' own views must give the side bar back first.
              useGitView.getState().closeChanges();
              useProjectDb.getState().togglePanel();
            },
          },
        ],
        // Any other activity button puts the file tree back.
        onOtherClick: () => useProjectDb.getState().closePanel(),
        subscribe: useProjectDb.subscribe,
      });

      const unsubscribe = useProjectDb.subscribe(sync);
      // The store may already hold tabs from before this extension activated.
      sync();

      context.subscriptions.push({
        dispose() {
          unsubscribe();
          button.dispose();
          for (const entry of panels.values()) entry.panel.dispose();
          panels.clear();
          known = new Set();
          useEditorTabs.getState().reset();
        },
      });
    },
  });

  return {
    extension,
    adopt(tabId, panel) {
      if (panels.has(tabId)) return;
      panel.webview.html = "";
      panels.set(tabId, { panel, surface: surfaceOf(tabId) });
      watch(tabId, panel);
    },
  };
}
