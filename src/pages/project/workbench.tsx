import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, Loader2 } from "lucide-react";
import { Workbench } from "codelet/workbench";
import { remote } from "codelet/extensions/remote";
import { extensions as extensionsView } from "codelet/extensions/extensions";
import { search } from "codelet/extensions/search";
import { Group, Panel, Separator } from "react-resizable-panels";
import { clearActiveProject, setActiveProject } from "@/commands";
import { PreviewTab } from "@/components/file-preview/preview-tab";
import { createProjectDbActivityExtension } from "@/features/database/project/activity-extension";
import { ProjectResultsDock } from "@/features/database/project/results-dock";
import { ProjectDatabaseSidebar } from "@/features/database/project/sidebar";
import { createSqlEditorExtension } from "@/features/database/project/sql-extension";
import { ProjectSqlTab } from "@/features/database/project/sql-tab";
import { ProjectTableTab } from "@/features/database/project/table-tab";
import { useProjectDb, projectTabTitle } from "@/features/database/project/view-store";
import { CommitPane } from "@/features/git/project/commit-pane";
import { CompareTab } from "@/features/git/project/compare-tab";
import { DiffTab } from "@/features/git/project/diff-tab";
import { FileHistoryTab } from "@/features/git/project/file-history-tab";
import { ensureEngineLine } from "@/features/git/project/git-console";
import { GitToolWindow } from "@/features/git/project/git-tool-window";
import { useGitView } from "@/features/git/project/git-view-store";
import { useProjectRepo } from "@/features/git/project/project-repo-store";
import { RevisionFileTab } from "@/features/git/project/revision-file-tab";
import { RevisionTreeTab } from "@/features/git/project/revision-tree-tab";
import type { ProjectTabOpeners } from "@/features/git/project/tab-openers";
import { basename } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { codeletStrings, createDomTranslator, localizeExtensions } from "@/lib/editor/codelet-i18n";
import { WorkbenchSurface } from "@/lib/editor/workbench-surface";
import { useEditorTabs, type DiffTabTarget, type EditorTabSurface } from "@/lib/editor/editor-tabs";
import {
  createGitActivityExtension,
  type GitActivityHandle,
} from "@/lib/editor/git-activity-extension";
import { createMarkdownPreviewExtension } from "@/lib/editor/markdown-preview-extension";
import { createPreviewExtension } from "@/lib/editor/preview-extension";
import { useEditorAppearance } from "@/lib/editor/use-editor-appearance";
import { useVcsStatus } from "@/lib/editor/use-vcs-status";
import {
  createVcsDecorationExtension,
  type VcsDecorationHandle,
  type VcsKind,
} from "@/lib/editor/vcs-decorations";
import { createProjectTransport } from "@/lib/editor/project-transport";
import { EDITOR_SURFACE_CLASS } from "@/lib/editor/typography";

/** Loaded on first preview, so marked, KaTeX and highlight.js stay off this page's first paint. */
const MarkdownPreviewTab = lazy(() => import("@/lib/editor/markdown-preview-tab"));

/**
 * The content of a database tab. codelet only says which tab is in front, so
 * this is where the store decides whether that is a SQL editor or a table.
 */
function ProjectDbTabView({ tabId }: { tabId: string }) {
  const tab = useProjectDb((state) => state.tabs.find((entry) => entry.id === tabId) ?? null);
  if (!tab) return null;
  return tab.kind === "table" ? <ProjectTableTab tab={tab} /> : <ProjectSqlTab tab={tab} />;
}

/**
 * One project root, opened as an editor.
 *
 * The same codelet `Workbench` the notes page mounts, with one difference that
 * matters: the files come from `codelet/extensions/remote` reading on demand
 * rather than from an in-memory filesystem loaded up front. A project tree can
 * hold `.git`, `node_modules` and build output — far too much to read into a
 * page — so the tree is fetched one level at a time, and `.git` is never served.
 *
 * Git itself is drawn by the host around that shell, in the two places the IDE
 * puts it: a tool window docked below the editor (log, console, working tree),
 * and a commit view that covers the side bar. Diffs are the only Git views that
 * become editor tabs, since they are the only ones the tab strip can close.
 *
 * The root comes from the window that mounts this: every command below finds it
 * through `setActiveProject`, so two project windows never share one.
 */
export default function ProjectWorkbench({ root }: { root: string }) {
  const { t, language } = useAppTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const workbenchRef = useRef<Workbench | null>(null);
  const vcsRef = useRef<VcsDecorationHandle | null>(null);
  const activityRef = useRef<GitActivityHandle | null>(null);
  const { theme, prefs } = useEditorAppearance();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The working copy the page is showing; the file tree's git colours come from it.
  const [repo, setRepo] = useState<string | null>(null);
  const { kinds, refresh } = useVcsStatus(repo);
  // Which editor tab is a host-drawn view, and which view it is.
  const surface = useEditorTabs((state) => state.surface);
  const panelOpen = useGitView((state) => state.panelOpen);
  const changesOpen = useGitView((state) => state.changesOpen);
  const refreshToken = useGitView((state) => state.refreshToken);
  const dbPanelOpen = useProjectDb((state) => state.panelOpen);
  const dbDockOpen = useProjectDb((state) => state.dockOpen);

  // Callbacks captured by the mount effect, which must not re-run for them.
  const refreshRef = useRef(refresh);
  const kindsRef = useRef(kinds);
  useEffect(() => {
    refreshRef.current = refresh;
    kindsRef.current = kinds;
  }, [refresh, kinds]);

  useEffect(() => {
    // Every command in this window reads the root from here; leaving it set
    // while another project owns the window would send work to the wrong one.
    setActiveProject(root);
    // The console's first line, asked for before anything else can log: the
    // engine's own answer would otherwise land after the reads that follow.
    ensureEngineLine();
    let alive = true;
    setRepo(null);
    // The commit view and the tool window read from this page's own repository
    // store; opening it here means a save can refresh it even before they mount.
    //
    // The store answers with the repository's canonical path — libgit2 reports
    // forward slashes, the path as given may not. Every view compares that
    // answer against the `repo` handed down here, so adopting it is what makes
    // those comparisons hold.
    void useProjectRepo
      .getState()
      .open(root)
      .then(
        (info) => {
          if (alive) setRepo(info.path);
        },
        () => {
          // The views report the failure themselves; the tree still colours
          // from the root as given.
          if (alive) setRepo(root);
        }
      );
    return () => {
      alive = false;
      clearActiveProject(root);
    };
  }, [root]);

  // Mount the shell once, and again when the Extensions view is toggled or the
  // language changes — both the extension set and the shell's wording are
  // mount-time options, and only a rebuild can change either. The remote
  // extension re-reads the tree on each mount, so no unsaved state is lost by
  // the rebuild.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let domTranslator: { dispose: () => void } | null = null;
    const transport = createProjectTransport();
    const vcs = createVcsDecorationExtension({
      label: (kind: VcsKind) => t(`projectGit.status.${kind}`),
    });
    // Painted on the first frame: the status the hook already holds is what the
    // tree would have asked for anyway.
    vcs.setData(kindsRef.current);
    vcsRef.current = vcs;

    const title = (surface: EditorTabSurface) => {
      const short = (rev: string) => (rev.length > 8 ? rev.slice(0, 8) : rev);
      if (surface.kind === "diff") {
        const target = surface.target;
        const name = basename(target.path);
        if (target.oid) return `${name} @ ${target.oid.slice(0, 7)}`;
        return target.staged ? `${name} — ${t("gitRepo.diff.panel.staged")}` : name;
      }
      if (surface.kind === "compare") {
        const name = surface.path ? `${basename(surface.path)}: ` : "";
        const right = surface.right ? short(surface.right) : t("projectGit.workingTree");
        return `${name}${short(surface.left)} → ${right}`;
      }
      if (surface.kind === "revisionFile") {
        return `${basename(surface.path)} @ ${surface.oid.slice(0, 7)}`;
      }
      if (surface.kind === "revisionTree") {
        return `${t("projectGit.revisionTree.title")} @ ${surface.oid.slice(0, 7)}`;
      }
      if (surface.kind === "fileHistory") {
        const name = t("projectGit.fileHistory.tabTitle", { name: basename(surface.path) });
        return surface.fromOid ? `${name} @ ${surface.fromOid.slice(0, 7)}` : name;
      }
      if (surface.kind === "dbTab") {
        const tab = useProjectDb.getState().tabs.find((entry) => entry.id === surface.tabId);
        return tab ? projectTabTitle(tab) : t("projectDb.activityTitle");
      }
      return surface.name;
    };
    const activity = createGitActivityExtension({
      parent: host,
      gitLabel: t("projectGit.activityTitle"),
      commitLabel: t("projectGit.commitActivityTitle"),
      title,
    });
    activityRef.current = activity;

    const dbActivity = createProjectDbActivityExtension({
      parent: host,
      label: t("projectDb.activityTitle"),
      title: (tab) => projectTabTitle(tab),
    });
    const sqlEditor = createSqlEditorExtension({
      displayName: t("projectDb.sqlEditor"),
      adopt: dbActivity.adopt,
    });

    const extensions = [
      vcs.extension,
      search,
      ...(prefs.extensionsView ? [extensionsView] : []),
      createMarkdownPreviewExtension(),
      remote({
        url: "tauri://project",
        transport,
        // The working copy's own `.git` is never served, matching the backend;
        // `.wh` is the project database's workspace and is the panel's alone.
        exclude: [".git", ".wh"],
        // Names on expand, bodies on open — the lazy end of the protocol.
        preload: "none",
        watch: false,
      }),
      // Formats the text editor can only render as gibberish are claimed here, and their
      // tabs become a preview drawn by the host instead — see `preview-extension`.
      createPreviewExtension({ displayName: t("filePreview.title") }),
      // Any `.sql` file is claimed by the database's own editor, which carries
      // the data-source picker, Run and the results dock.
      sqlEditor,
      // Last on purpose: codelet lists contributed containers in extension order, so
      // this is what puts the Git and Commit buttons below Extensions.
      activity.extension,
      // After Git: the database button sits below Commit in the activity bar.
      dbActivity.extension,
    ];
    // Nothing to translate in English, and then the extensions go in as they
    // came — which is what keeps the untranslated page free of copies.
    const strings = codeletStrings(language);

    try {
      const workbench = new Workbench({
        parent: host,
        theme,
        extensions: localizeExtensions(extensions, strings),
        // A save is the moment a file most likely changed status; the hook
        // batches the burst a format-on-save produces, and the Git views re-read
        // the working copy they may be showing.
        onSave: () => {
          useGitView.getState().requestRefresh();
          void useProjectRepo
            .getState()
            .refreshStatus()
            .catch(() => undefined);
        },
      });
      workbenchRef.current = workbench;
      // Started after the shell is up: what the extensions did not contribute —
      // menus, placeholders, the status bar — is rewritten in place, and stays
      // rewritten for as long as the shell stands.
      domTranslator = strings ? createDomTranslator(host, strings) : null;
      setReady(true);
    } catch (err) {
      console.error("project mount:", err);
      if (!disposed) setError(t("projectPage.openFailed"));
    }

    return () => {
      disposed = true;
      domTranslator?.dispose();
      workbenchRef.current?.destroy();
      workbenchRef.current = null;
      vcsRef.current = null;
      activityRef.current = null;
      // The shell took the tabs down with it; the views they were showing must
      // not outlive them.
      useEditorTabs.getState().reset();
      // The database tabs and results go with the shell too; the connections
      // stay open, as they do in the database windows.
      useProjectDb.getState().resetView();
      useGitView.getState().reset();
    };
    // `theme` is applied by the effect below, so it is deliberately not a
    // dependency — it would remount the shell on every light/dark flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount only on the extension set
  }, [prefs.extensionsView, language, t]);

  // Every fetch of the status lands here; the workbench keeps its own decoration
  // cache, so this is what tells it the colours moved.
  useEffect(() => {
    vcsRef.current?.setData(kinds);
  }, [kinds]);

  // Every Git view that re-reads the working copy asks through this token —
  // a save, a stage, a commit — and the tree follows with its colours.
  useEffect(() => {
    if (repo) refreshRef.current();
  }, [refreshToken, repo]);

  // The theme may resolve after the workbench mounts (the app's dark class is
  // applied in a provider effect) and changes again on a settings edit.
  useEffect(() => {
    workbenchRef.current?.setTheme(theme);
  }, [theme]);

  const openDiff = useCallback((target: DiffTabTarget) => {
    activityRef.current?.openDiff(target);
  }, []);

  const openers = useMemo<ProjectTabOpeners>(
    () => ({
      openDiff,
      openCompare: (left, right, path) => activityRef.current?.openCompare(left, right, path),
      openRevisionFile: (oid, path) => activityRef.current?.openRevisionFile(oid, path),
      openRevisionTree: (oid) => activityRef.current?.openRevisionTree(oid),
      openFileHistory: (path, fromOid) => activityRef.current?.openFileHistory(path, fromOid),
      openFile: (path) => activityRef.current?.openFile(path) ?? Promise.resolve(false),
    }),
    [openDiff]
  );

  return (
    <section className="border-border relative flex h-full min-h-[60vh] flex-1 flex-col overflow-hidden rounded-xl border">
      <Group orientation="vertical" className="min-h-0 flex-1">
        <Panel id="workbench" defaultSize="66" minSize="25" className="relative overflow-hidden">
          {/* Mounted always so the ref is set before the workbench builds.
              `editor-surface` is what the typography override attaches to. */}
          <div ref={hostRef} className={`h-full ${EDITOR_SURFACE_CLASS}`} />
          {/* Diffs and previews are workbench tabs; their frames are blank
              and these are drawn exactly over the active one. */}
          <WorkbenchSurface selector="main.cl-editor iframe" active={surface !== null}>
            {surface?.kind === "diff" && <DiffTab repo={repo} target={surface.target} />}
            {surface?.kind === "preview" && (
              <PreviewTab path={surface.path} name={surface.name} root={root} />
            )}
            {surface?.kind === "markdown" && (
              <Suspense fallback={null}>
                <MarkdownPreviewTab path={surface.path} root={root} />
              </Suspense>
            )}
            {surface?.kind === "compare" && (
              <CompareTab
                repo={repo}
                left={surface.left}
                right={surface.right}
                path={surface.path}
              />
            )}
            {surface?.kind === "revisionFile" && (
              <RevisionFileTab repo={repo} oid={surface.oid} path={surface.path} />
            )}
            {surface?.kind === "revisionTree" && (
              <RevisionTreeTab repo={repo} oid={surface.oid} openers={openers} />
            )}
            {surface?.kind === "fileHistory" && (
              <FileHistoryTab
                repo={repo}
                path={surface.path}
                fromOid={surface.fromOid}
                openers={openers}
              />
            )}
            {surface?.kind === "dbTab" && <ProjectDbTabView tabId={surface.tabId} />}
          </WorkbenchSurface>
          {/* The commit button's view covers the file tree, not the editor. */}
          <WorkbenchSurface selector="aside.cl-sidebar" active={changesOpen}>
            <CommitPane
              repo={repo}
              openers={openers}
              onClose={() => useGitView.getState().closeChanges()}
            />
          </WorkbenchSurface>
          {/* The database button's panel covers the same tree; the two are
              mutually exclusive, so only one surface is ever active. */}
          <WorkbenchSurface selector="aside.cl-sidebar" active={dbPanelOpen && !changesOpen}>
            <ProjectDatabaseSidebar />
          </WorkbenchSurface>
        </Panel>

        {panelOpen && (
          <>
            <Separator className="bg-border h-px" />
            <Panel id="git" defaultSize="34" minSize="12" className="overflow-hidden">
              <GitToolWindow repo={repo} openers={openers} />
            </Panel>
          </>
        )}

        {dbDockOpen && (
          <>
            <Separator className="bg-border h-px" />
            <Panel id="db-results" defaultSize="30" minSize="12" className="overflow-hidden">
              <ProjectResultsDock />
            </Panel>
          </>
        )}
      </Group>

      {!ready && (
        <div className="bg-background absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 text-sm">
          {error ? (
            <>
              <FolderGit2 className="text-muted-foreground size-6" />
              <p className="text-destructive max-w-md text-center">{error}</p>
            </>
          ) : (
            <>
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
              <span className="text-muted-foreground">{t("projectPage.loading")}</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}
