import { useEffect, useState } from "react";
import { GitBranch, Home, Loader2, TriangleAlert } from "lucide-react";
import { worktreeList } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { WorktreeInfo } from "@/lib/git-core";
import { cn } from "@/lib/utils";
import { useGitView } from "./git-view-store";

/**
 * The worktrees of the working copy the page is showing.
 *
 * One repository can have its branches checked out in several folders at once —
 * the project's own folder, and the neighbours created for other branches. This
 * tab lists them by name, branch and path, the way the IDE's Worktrees node
 * does. Read-only: switching copies is opening that folder, which this page
 * does not do.
 */
export function WorktreesView({ repo }: { repo: string | null }) {
  const { t } = useAppTranslation();
  const refreshToken = useGitView((state) => state.refreshToken);
  const [worktrees, setWorktrees] = useState<readonly WorktreeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) {
      setWorktrees(null);
      setError(null);
      return;
    }
    let cancelled = false;
    worktreeList(repo).then(
      (list) => {
        if (cancelled) return;
        setWorktrees(list);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [repo, refreshToken]);

  if (!repo) {
    return <p className="text-muted-foreground px-2 py-3 text-xs">{t("projectGit.noRepo")}</p>;
  }
  if (error) {
    return (
      <p className="text-destructive px-2 py-2 text-[11px] [overflow-wrap:anywhere]">
        {t("projectGit.statusFailed", { message: error })}
      </p>
    );
  }
  if (!worktrees) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-1">
      {worktrees.map((worktree) => (
        <WorktreeRow key={worktree.path} worktree={worktree} />
      ))}
    </div>
  );
}

function WorktreeRow({ worktree }: { worktree: WorktreeInfo }) {
  const { t } = useAppTranslation();
  const branch = worktree.isMissing
    ? t("gitRepo.sidebar.worktreeRow.folderMissing")
    : worktree.isDetached
      ? t("gitRepo.sidebar.worktreeRow.detached", { oid: worktree.headOid?.slice(0, 8) ?? "?" })
      : (worktree.branch ?? t("gitRepo.sidebar.worktreeRow.noBranch"));

  return (
    <div
      className="hover:bg-accent/50 flex flex-col gap-0.5 rounded px-2 py-1"
      title={worktree.path}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          className={cn(
            "min-w-0 truncate",
            worktree.isCurrent && "text-primary font-medium",
            worktree.isMissing && "text-muted-foreground"
          )}
        >
          {worktree.name}
        </span>
        {worktree.isMain && (
          <Home
            className="text-muted-foreground/70 size-3 shrink-0"
            aria-label={t("gitRepo.sidebar.worktreeRow.main")}
          />
        )}
        {worktree.isMissing && (
          <TriangleAlert
            className="text-destructive size-3 shrink-0"
            aria-label={t("gitRepo.sidebar.worktreeRow.missingAria")}
          />
        )}
      </span>
      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
        <GitBranch className="size-3 shrink-0" />
        <span className="shrink-0">{branch}</span>
        <span className="text-faint min-w-0 truncate font-mono">{worktree.path}</span>
      </span>
    </div>
  );
}
