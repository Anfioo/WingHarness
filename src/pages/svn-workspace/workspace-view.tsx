import { lazy, Suspense, useEffect, type ComponentType } from "react";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ChevronDown,
  Construction,
  Code,
  Download,
  FolderOpen,
  GitCompare,
  History,
  List,
  Loader2,
  RefreshCw,
  Settings,
  Terminal,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openWorkspaceTarget } from "@/commands";
import { useSvnWorkspace } from "@/features/svn-workspace/use-workspace";
import { hasChanges, useSvnWorkspaceStore, type SvnTabId } from "@/features/svn-workspace/store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { OpenTarget } from "@/lib/svn-core";
import { showSvnHome } from "@/lib/svn-windows";
import { cn } from "@/lib/utils";
import { WelcomeView } from "./welcome-view";

const STATUS_REFRESH_MS = 60_000;

type TabGroup = "workingCopy" | "repository" | "application";

interface TabDef {
  id: SvnTabId;
  icon: ComponentType<{ className?: string }>;
  group: TabGroup;
}

/** The nine panels, in the order the reference's sidebar listed them. */
const TABS: TabDef[] = [
  { id: "changes", icon: List, group: "workingCopy" },
  { id: "log", icon: History, group: "workingCopy" },
  { id: "commit", icon: Upload, group: "repository" },
  { id: "update", icon: RefreshCw, group: "repository" },
  { id: "diff", icon: GitCompare, group: "repository" },
  { id: "stash", icon: Archive, group: "repository" },
  { id: "blame", icon: UserRound, group: "repository" },
  { id: "checkout", icon: Download, group: "application" },
  { id: "settings", icon: Settings, group: "application" },
];

const GROUPS: TabGroup[] = ["workingCopy", "repository", "application"];

const TAB_IDS = TABS.map((tab) => tab.id);

/**
 * The feature's panels, discovered so this shell mounts each one as soon as it
 * lands. Every panel is a default export of
 * `src/features/svn-workspace/<tab>/index.tsx`; a tab whose module does not
 * exist yet (or whose module exports no component) falls back to
 * {@link PlaceholderPanel}, and the glob compiles even when it resolves to nothing.
 */
const PANEL_MODULES = import.meta.glob<Record<string, unknown>>(
  "../../features/svn-workspace/*/index.tsx"
);

function panelLoader(tab: SvnTabId): (() => Promise<Record<string, unknown>>) | null {
  const suffix = `/${tab}/index.tsx`;
  const key = Object.keys(PANEL_MODULES).find((entry) => entry.endsWith(suffix));
  return key ? PANEL_MODULES[key] : null;
}

const PANELS: Partial<Record<SvnTabId, ComponentType>> = {};
for (const tab of TAB_IDS) {
  const load = panelLoader(tab);
  if (!load) continue;
  PANELS[tab] = lazy(async () => {
    const module = await load();
    const candidate = (module.default ?? module.Panel ?? module[`${tab}Panel`] ?? module[tab]) as
      | ComponentType
      | undefined;
    return { default: candidate ?? (() => <PlaceholderPanel tab={tab} />) };
  });
}

function PlaceholderPanel({ tab }: { tab: SvnTabId }) {
  const { t } = useAppTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg"
      >
        <Construction className="size-5" />
      </span>
      <p className="text-sm font-medium">{t(`svnWorkspace.common.tabs.${tab}`)}</p>
      <p className="text-muted-foreground max-w-xs text-xs">
        {t("svnWorkspace.common.panelPending")}
      </p>
    </div>
  );
}

function PanelLoading() {
  const { t } = useAppTranslation();
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
      <Loader2 className="size-4 animate-spin" />
      {t("svnWorkspace.common.loading")}
    </div>
  );
}

/** Last path segment of the working copy, for the header. */
function baseName(path: string) {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The in-window shell of one working copy: a header, the nine-panel navigation
 * and the panel host, mirroring the reference's `MainLayout` + `App.vue`. The
 * reference drove the panels through vue-router; here the active panel is
 * {@link SvnWorkspaceStore.activeTab}, so switching is store state rather than
 * a URL.
 *
 * The layout itself is what this phase ships; each panel is a placeholder until
 * its own phase lands (see {@link PANELS}).
 */
export function WorkspaceView({ path }: { path: string }) {
  const { t } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((state) => state.workspacePath);
  const svnInfo = useSvnWorkspaceStore((state) => state.svnInfo);
  const statusList = useSvnWorkspaceStore((state) => state.statusList);
  const isLoading = useSvnWorkspaceStore((state) => state.isLoading);
  const statusIsStale = useSvnWorkspaceStore((state) => state.statusIsStale);
  const error = useSvnWorkspaceStore((state) => state.error);
  const activeTab = useSvnWorkspaceStore((state) => state.activeTab);
  const setActiveTab = useSvnWorkspaceStore((state) => state.setActiveTab);
  const clearWorkspace = useSvnWorkspaceStore((state) => state.clearWorkspace);

  const { loadWorkspace, refreshStatus, refreshStatusIfStale } = useSvnWorkspace();

  useEffect(() => {
    void loadWorkspace(path).catch(() => undefined);
  }, [loadWorkspace, path]);

  // Silent background refresh, as the reference ran on a 60s timer.
  useEffect(() => {
    const id = window.setInterval(() => {
      const state = useSvnWorkspaceStore.getState();
      if (!state.workspacePath || state.isLoading) return;
      void refreshStatusIfStale(STATUS_REFRESH_MS);
    }, STATUS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshStatusIfStale]);

  const closeWorkspace = () => {
    clearWorkspace();
    void showSvnHome();
  };

  const openIn = async (target: OpenTarget) => {
    if (!workspacePath) return;
    try {
      await openWorkspaceTarget(workspacePath, target);
    } catch (err) {
      toast.error(t("svnWorkspace.common.error"), { description: String(err) });
      console.error("Failed to open the working copy externally:", err);
    }
  };

  // A window can outlive its working copy (closed, or cleared): fall back to the
  // no-workspace guidance rather than an empty shell.
  if (!workspacePath) {
    return <WelcomeView />;
  }

  const Panel = PANELS[activeTab];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="border-border flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void showSvnHome()}
          aria-label={t("svnWorkspace.welcome.recent.title")}
          title={t("svnWorkspace.welcome.recent.title")}
          className="shrink-0"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="truncate text-sm font-medium">{baseName(workspacePath)}</span>
        {svnInfo ? (
          <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
            r{svnInfo.revision}
          </Badge>
        ) : null}
        {isLoading ? (
          <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refreshStatus()}
            disabled={isLoading}
            aria-label={t("svnWorkspace.common.refresh")}
            title={t("svnWorkspace.common.refresh")}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveTab("update")}
            className={cn(activeTab === "update" && "bg-accent text-accent-foreground")}
          >
            {t("svnWorkspace.common.update")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setActiveTab("settings")}
            aria-label={t("svnWorkspace.common.tabs.settings")}
            title={t("svnWorkspace.common.tabs.settings")}
          >
            <Settings className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <FolderOpen className="size-4" />
                {t("svnWorkspace.common.openIn")}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => void openIn("explorer")}>
                <FolderOpen className="size-3.5" />
                {t("svnWorkspace.common.openInExplorer")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void openIn("vscode")}>
                <Code className="size-3.5" />
                {t("svnWorkspace.common.openInVscode")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void openIn("terminal")}>
                <Terminal className="size-3.5" />
                {t("svnWorkspace.common.openInTerminal")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={closeWorkspace}
            aria-label={t("svnWorkspace.common.closeWorkspace")}
            title={t("svnWorkspace.common.closeWorkspace")}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("svnWorkspace.common.tabs.changes")}
          className="border-border w-48 shrink-0 overflow-y-auto border-r p-2"
        >
          {GROUPS.map((group) => (
            <div key={group} className="mb-2">
              <div className="text-faint px-2 py-1 text-[11px] font-semibold tracking-wide uppercase">
                {t(`svnWorkspace.common.groups.${group}`)}
              </div>
              {TABS.filter((tab) => tab.group === group).map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === activeTab;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="flex-1 truncate text-left">
                      {t(`svnWorkspace.common.tabs.${tab.id}`)}
                    </span>
                    {tab.id === "changes" && statusList.length > 0 ? (
                      <span className="text-faint text-xs">{statusList.length}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error ? (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 border-b px-3 py-2 text-xs"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}
          {statusIsStale ? (
            <div
              role="status"
              className="text-muted-foreground bg-muted/40 border-b px-3 py-1.5 text-xs"
            >
              {t("svnWorkspace.common.staleStatus")}
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {Panel ? (
              <Suspense fallback={<PanelLoading />}>
                <Panel />
              </Suspense>
            ) : (
              <PlaceholderPanel tab={activeTab} />
            )}
          </div>
        </div>
      </div>

      <footer className="border-border text-faint flex h-6 shrink-0 items-center justify-between gap-3 border-t px-3 text-[11px]">
        <span className="min-w-0 truncate" title={workspacePath}>
          {workspacePath}
        </span>
        <div className="flex shrink-0 items-center gap-3">
          {hasChanges(statusList) ? (
            <span>{t("svnWorkspace.common.changesCount", { count: statusList.length })}</span>
          ) : null}
          {svnInfo ? <span>r{svnInfo.revision}</span> : null}
        </div>
      </footer>
    </div>
  );
}

export default WorkspaceView;
