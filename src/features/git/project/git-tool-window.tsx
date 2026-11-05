import { ChevronDown, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ConsolePane } from "./console-pane";
import { useGitConsole } from "./git-console";
import { GitLogView } from "./git-log-view";
import { useGitView, type GitToolTab } from "./git-view-store";
import type { ProjectTabOpeners } from "./tab-openers";
import { WorktreesView } from "./worktrees-pane";

const tabClass = (active: boolean) =>
  cn(
    "-mb-px h-full max-w-[20rem] truncate border-b-2 px-2.5 text-xs whitespace-nowrap transition-colors",
    active
      ? "border-primary text-foreground font-medium"
      : "text-muted-foreground hover:text-foreground border-transparent"
  );

/**
 * The Git tool window, docked below the editor: the log of the current branch,
 * the commands this page has run, and the working tree's changes.
 *
 * One header holds the three tabs and the actions that belong to whichever is
 * showing — the same arrangement as the IDE's Git window, so the tab label is
 * the branch the log is looking at.
 */
export function GitToolWindow({
  repo,
  openers,
}: {
  repo: string | null;
  openers: ProjectTabOpeners;
}) {
  const { t } = useAppTranslation();
  const tab = useGitView((state) => state.tab);
  const branch = useGitView((state) => state.branch);
  const currentBranch = useGitView((state) => state.currentBranch);
  const setTab = useGitView((state) => state.setTab);

  const showing = branch ?? currentBranch;
  const tabs: Array<{ id: GitToolTab; label: string }> = [
    {
      id: "log",
      label: showing ? t("projectGit.logTabBranch", { branch: showing }) : t("projectGit.logTab"),
    },
    { id: "console", label: t("projectGit.consoleTab") },
    { id: "workingTree", label: t("projectGit.workingTreeTab") },
  ];

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <div className="border-border flex h-7 shrink-0 items-stretch gap-1 border-b px-1.5">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tabClass(tab === item.id)}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        <span className="flex-1" />
        {tab === "console" ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("projectGit.clearConsole")}
            title={t("projectGit.clearConsole")}
            onClick={() => useGitConsole.getState().clear()}
          >
            <Trash2 className="size-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("projectGit.refresh")}
            title={t("projectGit.refresh")}
            onClick={() => useGitView.getState().requestRefresh()}
          >
            <RotateCw className="size-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("projectGit.closePanel")}
          title={t("projectGit.closePanel")}
          onClick={() => useGitView.getState().closePanel()}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "log" ? (
          <GitLogView repo={repo} openers={openers} />
        ) : tab === "console" ? (
          <div className="flex h-full min-h-0 flex-col">
            <ConsolePane repo={repo} />
          </div>
        ) : (
          <WorktreesView repo={repo} />
        )}
      </div>
    </div>
  );
}
