import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AlertCircle, Loader2 } from "lucide-react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmHost } from "@/components/confirm";
import { CommandPalette } from "@/components/git/command-palette";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { repoRefFingerprint, remoteFetch, watchRepo, watchStop } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { useUi } from "@/features/git/ui-store";
import { useGraph } from "@/features/git/graph";
import { useGitSettings } from "@/features/git/settings";
import { useUndo } from "@/features/git/history/undoStore";
import { seedForgeHostsFromAccounts, useForge } from "@/features/git/forge";
import { CreatePrDialog } from "@/features/git/forge/CreatePrDialog";
import { GitSettingsPanel } from "@/features/git/settings";
import { RemoteDialogs } from "@/features/git/remote";
import { ConflictResolver } from "@/features/git/conflicts";
import { CreateWorktreeDialog } from "@/features/git/worktrees/CreateWorktreeDialog";
import { RepoTabs } from "@/features/git/repository/RepoTabs";
import { RepoDialogs } from "@/features/git/repository/RepoDialogs";
import { RepoGroupDialog } from "@/features/git/repository/RepoGroupDialog";
import { RepoQuickOpen } from "@/features/git/repository/RepoQuickOpen";
import { RepoShortcutDialog } from "@/features/git/repository/RepoShortcutDialog";
import { InteractiveRebaseDialog } from "@/features/git/repository/interactive-rebase-dialog";
import { closeRepoTabs, goToRepoHome } from "@/features/git/repository/tabs";
import { useRepoShortcuts } from "@/features/git/repository/use-repo-shortcuts";
import { fetchRemotes } from "@/features/git/repository/fetchRemotes";
import { useShortcuts, type Shortcut } from "@/features/git/diff/use-shortcuts";
import { normalizeRepoPath } from "@/lib/git-windows";
import { cn } from "@/lib/utils";
import { CenterPane } from "./center-pane";
import { InspectorPane } from "./inspector-pane";
import { PaneEmpty } from "./pane-empty";
import { SidebarPane } from "./sidebar-pane";
import { StatusBar } from "./status-bar";
import { Toolbar } from "./toolbar";

const SIDEBAR_DEFAULT_SIZE = 18;
const INSPECTOR_DEFAULT_SIZE = 28;
const INSPECTOR_MIN_SIZE = 20;

function RepoLoadingOverlay({ label }: { label: string }) {
  return (
    <div className="bg-background/70 absolute inset-0 z-20 flex items-center justify-center">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {label}
      </div>
    </div>
  );
}

export function RepositoryView({ path }: { path: string }) {
  const { t } = useAppTranslation();
  const open = useRepo((s) => s.open);
  const opening = useRepo((s) => s.opening);
  const repo = useRepo((s) => s.repo);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const centerDiff = useUi((s) => s.centerDiff);
  const centerEditor = useUi((s) => s.centerEditor);
  const centerFileHistory = useUi((s) => s.centerFileHistory);
  const closeCenterDiff = useUi((s) => s.closeCenterDiff);
  const conflictFile = useUi((s) => s.conflictFile);

  const [failed, setFailed] = useState(false);
  const sidebarPanel = usePanelRef();

  const layoutId = useMemo(() => `git-repo-layout:${normalizeRepoPath(path)}`, [path]);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: layoutId });

  const repoPath = repo?.path ?? null;

  useEffect(() => {
    let disposed = false;
    void open(path).catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => {
      disposed = true;
    };
  }, [path, open]);

  useEffect(() => {
    if (!repoPath) return;
    useGraph.getState().select(null);
    const ui = useUi.getState();
    ui.closeCenterDiff();
    ui.closeEditor();
    ui.closeFileHistory();
    ui.selectFile(null);
    ui.openConflict(null);

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    let refreshing = false;
    let pending = false;
    let refsFingerprint: string | null = null;
    const stillCurrent = () => !cancelled && useRepo.getState().repo?.path === repoPath;
    void repoRefFingerprint(repoPath)
      .then((fingerprint) => {
        if (stillCurrent() && refsFingerprint === null) refsFingerprint = fingerprint;
      })
      .catch(() => undefined);
    const handleChange = async () => {
      if (refreshing) {
        pending = true;
        return;
      }
      refreshing = true;
      try {
        do {
          pending = false;
          if (!stillCurrent()) return;
          const fingerprint = await repoRefFingerprint(repoPath);
          if (!stillCurrent()) return;
          const refsChanged = refsFingerprint !== fingerprint;
          refsFingerprint = fingerprint;
          if (refsChanged) {
            await useRepo.getState().refresh();
            if (!stillCurrent()) return;
            await useGraph.getState().reload(repoPath);
          } else {
            await useRepo.getState().refreshStatus();
          }
        } while (pending && stillCurrent());
      } finally {
        refreshing = false;
      }
    };
    void watchRepo(repoPath);
    void useGraph.getState().reload(repoPath);
    void listen("repo-changed", () => {
      void handleChange().catch(() => undefined);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      void watchStop();
    };
  }, [repoPath]);

  const repoRemotes = useRepo((s) => s.remotes);
  const repoBranches = useRepo((s) => s.branches);
  const forgeKey = useMemo(() => {
    if (repoRemotes.length === 0) return "";
    const upstream = repoBranches.find((b) => !b.isRemote && b.isHead)?.upstream ?? "";
    return `${repoRemotes.map((r) => `${r.name}=${r.url}`).join(",")}|${upstream}`;
  }, [repoRemotes, repoBranches]);
  const showPullRequests = useGitSettings((s) => s.showPullRequests);
  useEffect(() => {
    if (repoPath && forgeKey && showPullRequests) void useForge.getState().load();
    else useForge.getState().reset();
  }, [repoPath, forgeKey, showPullRequests]);

  const settingsOpen = useUi((s) => s.dialog === "settings");
  const settingsWasOpen = useRef(false);
  useEffect(() => {
    if (settingsOpen) {
      settingsWasOpen.current = true;
      return;
    }
    if (!settingsWasOpen.current) return;
    settingsWasOpen.current = false;
    if (repoPath && showPullRequests && (!forgeKey || !useForge.getState().hasAccount)) {
      void seedForgeHostsFromAccounts().then(() => useForge.getState().load(true));
    }
  }, [settingsOpen, repoPath, forgeKey, showPullRequests]);

  const autoFetchMinutes = useGitSettings((s) => s.autoFetchMinutes);
  const autoFetchRemotes = useRepo((s) => s.remotes.map((remote) => remote.name).join("\n"));
  useEffect(() => {
    if (!repoPath || !autoFetchMinutes || !autoFetchRemotes) return;
    let fetching = false;
    let cancelled = false;
    let lastAttemptAt = 0;
    const tick = async () => {
      if (fetching || cancelled || document.hidden) return;
      const state = useRepo.getState();
      if (state.busy || state.repo?.path !== repoPath) return;
      if (Date.now() - Math.max(lastAttemptAt, state.lastFetchAt ?? 0) < 30_000) return;
      const remoteNames = state.remotes.map((remote) => remote.name);
      if (remoteNames.length === 0) return;
      fetching = true;
      lastAttemptAt = Date.now();
      try {
        const result = await fetchRemotes(remoteNames, (name) =>
          remoteFetch(repoPath, name, true, false)
        );
        if (!cancelled && useRepo.getState().repo?.path === repoPath) {
          if (result.succeeded.length > 0) useRepo.getState().markFetched();
          useRepo.getState().setFetchFailures(result.failed.map(({ name }) => name));
        }
      } finally {
        fetching = false;
      }
    };
    const id = window.setInterval(() => void tick(), autoFetchMinutes * 60_000);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [repoPath, autoFetchMinutes, autoFetchRemotes]);

  const refreshAll = useCallback(async () => {
    const current = useRepo.getState().repo;
    if (!current) return;
    await useRepo.getState().refresh();
    await useGraph.getState().reload(current.path);
  }, []);

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      { combo: "mod+k", handler: () => useUi.getState().setPaletteOpen(true) },
      { combo: "mod+`", handler: () => useUi.getState().toggleTerminal() },
      { combo: "mod+b", handler: () => useUi.getState().toggleSidebar() },
      {
        combo: "mod+z",
        skipInInput: true,
        handler: () => {
          const current = useRepo.getState().repo?.path;
          if (current)
            void useUndo
              .getState()
              .undo(current)
              .then((ok) => {
                if (ok) void refreshAll();
              });
        },
      },
      {
        combo: "mod+shift+z",
        skipInInput: true,
        handler: () => {
          const current = useRepo.getState().repo?.path;
          if (current)
            void useUndo
              .getState()
              .redo(current)
              .then((ok) => {
                if (ok) void refreshAll();
              });
        },
      },
      { combo: "mod+r", handler: () => void refreshAll() },
      {
        combo: "mod+w",
        handler: (event: KeyboardEvent) => {
          if ((event.target as HTMLElement | null)?.closest(".xterm")) return;
          const current = useRepo.getState().repo?.path;
          if (current) closeRepoTabs([current]);
        },
      },
      { combo: "mod+,", handler: () => useUi.getState().openDialog("settings") },
      {
        combo: "escape",
        handler: () => {
          const ui = useUi.getState();
          if (ui.conflictFile) return;
          if (ui.centerEditor) ui.closeEditor();
          else if (ui.centerDiff) closeCenterDiff();
          else if (ui.centerFileHistory) ui.closeFileHistory();
        },
      },
    ],
    [refreshAll, closeCenterDiff]
  );
  useShortcuts(shortcuts);
  useRepoShortcuts();

  const focusMode = !!centerFileHistory && !centerEditor && !centerDiff;
  const showSidebar = sidebarOpen && !focusMode && !failed;

  useEffect(() => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (showSidebar) {
      if (panel.isCollapsed()) panel.expand();
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [showSidebar, repo, sidebarPanel]);

  if (failed) {
    return (
      <PaneEmpty icon={<AlertCircle />} title={t("gitRepo.shell.openFailed")}>
        <Button variant="secondary" size="sm" onClick={() => goToRepoHome(path)}>
          {t("gitRepo.shell.toolbar.home")}
        </Button>
      </PaneEmpty>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <RepoTabs />
        <Toolbar />
        <div className="relative min-h-0 flex-1">
          {!repo && opening ? (
            <RepoLoadingOverlay
              label={t("gitRepo.shell.opening", { name: normalizeRepoPath(path) })}
            />
          ) : null}
          <Group className="h-full" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
            <Panel
              panelRef={sidebarPanel}
              id="sidebar"
              defaultSize={`${SIDEBAR_DEFAULT_SIZE}`}
              minSize="13"
              collapsible
              collapsedSize="0"
              className="h-full overflow-hidden"
            >
              {showSidebar ? <SidebarPane /> : null}
            </Panel>
            <Separator className={cn("bg-border w-px", !showSidebar && "hidden")} />
            <Panel id="center" defaultSize="54" minSize="30" className="h-full overflow-hidden">
              <CenterPane layoutId={`${layoutId}:center`} />
            </Panel>
            <Separator className="bg-border w-px" />
            <Panel
              id="inspector"
              defaultSize={`${INSPECTOR_DEFAULT_SIZE}`}
              minSize={`${INSPECTOR_MIN_SIZE}`}
              className="h-full overflow-hidden"
            >
              <InspectorPane />
            </Panel>
          </Group>
        </div>
        <StatusBar />
        <CommandPalette />
        <GitSettingsPanel />
        <RepoDialogs />
        <RemoteDialogs />
        <CreatePrDialog />
        <CreateWorktreeDialog />
        <RepoShortcutDialog />
        <RepoGroupDialog />
        <InteractiveRebaseDialog />
        <RepoQuickOpen />
        <ConfirmHost />
        {conflictFile ? <ConflictResolver /> : null}
      </div>
    </TooltipProvider>
  );
}
