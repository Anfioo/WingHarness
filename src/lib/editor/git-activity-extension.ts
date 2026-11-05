import {
  defineExtension,
  Uri,
  ViewColumn,
  type Extension,
  type WebviewPanel,
} from "codelet/extensions";
import { useGitView } from "@/features/git/project/git-view-store";
import { useEditorTabs, type DiffTabTarget, type EditorTabSurface } from "@/lib/editor/editor-tabs";

/**
 * The two Git buttons on the activity bar, and the diff tabs behind them.
 *
 * codelet has one activity bar of its own, driven by `viewsContainers`, and no
 * Git icon in its closed set. So both containers are contributed for real — that
 * is what puts the buttons below Extensions with the same 48px chrome — their
 * icons are swapped for Git glyphs, and their clicks are intercepted before
 * codelet's handler can reveal an empty side bar:
 *
 * - the Git button opens the tool window docked below the editor;
 * - the Commit button covers the side bar with the working copy's changes.
 *
 * A diff is the one Git view that belongs in the editor, so it is opened as a
 * webview panel: codelet draws the tab strip, and the host lays the React view
 * over the blank frame the panel keeps.
 */

const GIT_CONTAINER_ID = "app.git.panel";
const COMMIT_CONTAINER_ID = "app.git.commit";
const PANEL_VIEW_TYPE = "app.gitDiff";
/** VSCode's own command for revealing a contributed view container. */
const GIT_COMMAND = `workbench.view.extension.${GIT_CONTAINER_ID}`;
const COMMIT_COMMAND = `workbench.view.extension.${COMMIT_CONTAINER_ID}`;

/** Lucide's `git-branch`, in the stroke shape codelet's own icons are drawn in. */
const GIT_BRANCH_ICON = [
  '<line x1="6" x2="6" y1="3" y2="15"/>',
  '<circle cx="18" cy="6" r="3"/>',
  '<circle cx="6" cy="18" r="3"/>',
  '<path d="M18 9a9 9 0 0 1-9 9"/>',
].join("");
/** Lucide's `git-commit`, for the button that opens the changes view. */
const GIT_COMMIT_ICON = [
  '<circle cx="12" cy="12" r="3"/>',
  '<line x1="3" x2="9" y1="12" y2="12"/>',
  '<line x1="15" x2="21" y1="12" y2="12"/>',
].join("");

interface ActivationApi {
  window: {
    createWebviewPanel: (
      viewType: string,
      title: string,
      showOptions: ViewColumn,
      options?: { enableScripts?: boolean }
    ) => WebviewPanel;
    /** Opens a file in an editor tab; rejects when no editor can show it. */
    showTextDocument?: (uri: Uri) => PromiseLike<unknown>;
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

export interface GitActivityOptions {
  /** The element the workbench was mounted into; the activity bar lives inside it. */
  parent: HTMLElement;
  /** The Git tool window's button label, already localized. */
  gitLabel: string;
  /** The commit view's button label, already localized. */
  commitLabel: string;
  /** Title a host-drawn tab carries, already localized. */
  title: (surface: EditorTabSurface) => string;
}

export interface GitActivityHandle {
  extension: Extension;
  openDiff: (target: DiffTabTarget) => void;
  openCompare: (left: string, right: string | null, path?: string) => void;
  openRevisionFile: (oid: string, path: string) => void;
  openRevisionTree: (oid: string) => void;
  openFileHistory: (path: string, fromOid?: string) => void;
  /** Resolves to false when the workbench has no editor to show the file in. */
  openFile: (path: string) => Promise<boolean>;
}

export function createGitActivityExtension(options: GitActivityOptions): GitActivityHandle {
  let api: ActivationApi | null = null;
  const panels = new Map<string, OpenPanel>();
  /** Makes every `forceNew` diff key distinct, so the tab strip never reuses one. */
  let forced = 0;

  const openPanel = (key: string, title: string, surface: EditorTabSurface) => {
    const existing = panels.get(key);
    if (existing) {
      existing.panel.reveal();
      // `reveal()` returns without an event in some cases; the surface is known
      // already, so mark it showing right away.
      useEditorTabs.getState().show(key, existing.surface);
      return;
    }
    if (!api) return;
    const panel = api.window.createWebviewPanel(PANEL_VIEW_TYPE, title, ViewColumn.One, {
      enableScripts: false,
    });
    const entry: OpenPanel = { panel, surface };
    panels.set(key, entry);
    // An empty string, not leaving it unset: codelet draws no frame while `html`
    // is undefined, and the host needs one to measure the area to cover.
    panel.webview.html = "";
    const sync = () => {
      const tabs = useEditorTabs.getState();
      if (panel.visible) tabs.show(key, surface);
      else tabs.hide(key);
    };
    panel.onDidChangeViewState(sync);
    panel.onDidDispose(() => {
      if (panels.get(key) === entry) panels.delete(key);
      useEditorTabs.getState().hide(key);
    });
    // A tab created as the active one does not report a visibility change: it
    // was already visible before the listener existed.
    sync();
  };

  const openDiff = (target: DiffTabTarget) => {
    const key = [
      "diff",
      target.oid ?? "worktree",
      target.staged ? "staged" : "unstaged",
      target.path,
      ...(target.forceNew ? ["new", String(++forced)] : []),
    ].join(":");
    const surface: EditorTabSurface = { kind: "diff", target };
    openPanel(key, options.title(surface), surface);
  };

  const openCompare = (left: string, right: string | null, path?: string) => {
    const key = ["compare", left, right ?? "worktree", path ?? ""].join(":");
    const surface: EditorTabSurface = { kind: "compare", left, right, path };
    openPanel(key, options.title(surface), surface);
  };

  const openRevisionFile = (oid: string, path: string) => {
    const key = ["revisionFile", oid, path].join(":");
    const surface: EditorTabSurface = { kind: "revisionFile", oid, path };
    openPanel(key, options.title(surface), surface);
  };

  const openRevisionTree = (oid: string) => {
    const key = ["revisionTree", oid].join(":");
    const surface: EditorTabSurface = { kind: "revisionTree", oid };
    openPanel(key, options.title(surface), surface);
  };

  const openFileHistory = (path: string, fromOid?: string) => {
    const key = ["fileHistory", path, fromOid ?? "head"].join(":");
    const surface: EditorTabSurface = { kind: "fileHistory", path, fromOid };
    openPanel(key, options.title(surface), surface);
  };

  const openFile = async (path: string): Promise<boolean> => {
    if (!api?.window.showTextDocument) return false;
    try {
      await api.window.showTextDocument(Uri.file(path));
      return true;
    } catch {
      return false;
    }
  };

  const extension = defineExtension({
    manifest: {
      name: "app-git-activity",
      contributes: {
        viewsContainers: {
          // Order matters: codelet lists contributed containers in this order.
          activitybar: [
            { id: GIT_CONTAINER_ID, title: options.gitLabel, icon: "activity" },
            { id: COMMIT_CONTAINER_ID, title: options.commitLabel, icon: "activity" },
          ],
        },
        // No views: these are buttons, and codelet renders a contributed
        // container whether or not anything is docked in it.
        views: {},
      },
    },
    activate(context, vscode) {
      api = vscode as unknown as ActivationApi;

      context.subscriptions.push(
        api.commands.registerCommand(GIT_COMMAND, () => useGitView.getState().togglePanel()),
        api.commands.registerCommand(COMMIT_COMMAND, () => useGitView.getState().toggleChanges())
      );

      interface Button {
        element: HTMLButtonElement;
        icon: string;
        onClick: (event: MouseEvent) => void;
      }
      const buttons: Button[] = [];
      let otherClick: ((event: MouseEvent) => void) | null = null;

      const findButton = (label: string) =>
        Array.from(
          options.parent.querySelectorAll<HTMLButtonElement>("button.cl-activity-item")
        ).find((candidate) => candidate.getAttribute("aria-label") === label) ?? null;

      const paintIcon = (element: HTMLButtonElement, icon: string) => {
        const svg = element.querySelector("svg");
        if (!svg) return;
        if (svg.getAttribute("data-app-icon") === icon) return;
        svg.innerHTML = icon;
        svg.setAttribute("data-app-icon", icon);
      };

      const syncActive = () => {
        const state = useGitView.getState();
        for (const button of buttons) {
          const active =
            button.element.getAttribute("aria-label") === options.gitLabel
              ? state.panelOpen
              : state.changesOpen;
          if (active) button.element.setAttribute("data-app-active", "");
          else button.element.removeAttribute("data-app-active");
        }
      };

      /** Capture on the button: codelet's own handler is delegated at the root. */
      const intercept = (action: () => void) => (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      };

      const attach = (label: string, icon: string, action: () => void) => {
        const element = findButton(label);
        if (!element) return false;
        const existing = buttons.find((button) => button.element === element);
        if (existing) {
          paintIcon(element, icon);
          return true;
        }
        const onClick = intercept(action);
        element.addEventListener("click", onClick, true);
        buttons.push({ element, icon, onClick });
        paintIcon(element, icon);
        return true;
      };

      const sync = () => {
        // A re-render can replace the buttons; drop the dead listeners.
        for (let index = buttons.length - 1; index >= 0; index -= 1) {
          const button = buttons[index];
          if (button.element.isConnected) continue;
          button.element.removeEventListener("click", button.onClick, true);
          buttons.splice(index, 1);
        }
        attach(options.gitLabel, GIT_BRANCH_ICON, () => useGitView.getState().togglePanel());
        attach(options.commitLabel, GIT_COMMIT_ICON, () => useGitView.getState().toggleChanges());
        syncActive();
      };

      // Any other activity button puts the side bar back: the changes view is
      // covering the explorer, and the button under it must still work.
      otherClick = (event) => {
        const element = event.target instanceof Element ? event.target.closest("button") : null;
        if (!element?.classList.contains("cl-activity-item")) return;
        if (buttons.some((button) => button.element === element)) return;
        useGitView.getState().closeChanges();
      };
      options.parent.addEventListener("click", otherClick, true);

      const observer = new MutationObserver(sync);
      observer.observe(options.parent, { childList: true, subtree: true });
      const unsubscribe = useGitView.subscribe(syncActive);
      sync();

      context.subscriptions.push({
        dispose() {
          observer.disconnect();
          unsubscribe();
          if (otherClick) options.parent.removeEventListener("click", otherClick, true);
          for (const button of buttons) {
            button.element.removeEventListener("click", button.onClick, true);
          }
          buttons.length = 0;
          panels.clear();
          useEditorTabs.getState().reset();
        },
      });
    },
  });

  return {
    extension,
    openDiff,
    openCompare,
    openRevisionFile,
    openRevisionTree,
    openFileHistory,
    openFile,
  };
}
