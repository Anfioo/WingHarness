import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  GitBranchPlus,
  Loader2,
} from "lucide-react";
import { pickRemote } from "@/lib/git-core";
import { Button } from "@/components/ui/button";
import { Hint } from "@/features/git/diff/diff-ui";
import { useGitSettings } from "@/features/git/settings";
import { useRepo } from "@/features/git/repository-store";
import { capCount, currentPullRequestUrl, timeAgo } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

export function StatusBar({ className }: { className?: string }) {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const status = useRepo((state) => state.status);
  const branches = useRepo((state) => state.branches);
  const remotes = useRepo((state) => state.remotes);
  const conflicts = useRepo((state) => state.conflicts);
  const busy = useRepo((state) => state.busy);
  const refreshing = useRepo((state) => state.refreshing);
  const lastFetchAt = useRepo((state) => state.lastFetchAt);
  const fetchFailures = useRepo((state) => state.fetchFailures);
  const showPullRequests = useGitSettings((state) => state.showPullRequests);

  const branch = repo
    ? repo.isDetached
      ? t("gitRepo.shell.refs.detached")
      : repo.headBranch
    : null;
  const changed = status?.files.length ?? 0;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  const headUpstream =
    branches.find((candidate) => !candidate.isRemote && candidate.isHead)?.upstream ?? null;
  const remote = pickRemote(remotes, headUpstream)?.name ?? "origin";
  const remoteUrl = remotes.find((candidate) => candidate.name === remote)?.url;
  const pullRequestUrl = showPullRequests ? currentPullRequestUrl(repo, remoteUrl) : null;

  return (
    <div
      className={cn(
        "border-border bg-card text-muted-foreground flex h-7 shrink-0 items-center gap-3 border-t px-3 text-xs",
        className
      )}
    >
      {repo ? (
        <>
          {branch ? (
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          ) : null}
          {ahead > 0 ? (
            <Hint label={t("gitRepo.shell.statusBar.ahead", { count: ahead })} side="top">
              <span className="flex items-center gap-1">
                <ArrowUp className="size-3.5" />
                {capCount(ahead)}
              </span>
            </Hint>
          ) : null}
          {behind > 0 ? (
            <Hint label={t("gitRepo.shell.statusBar.behind", { count: behind })} side="top">
              <span className="flex items-center gap-1">
                <ArrowDown className="size-3.5" />
                {capCount(behind)}
              </span>
            </Hint>
          ) : null}
          {changed > 0 ? (
            <span>{t("gitRepo.shell.statusBar.filesChanged", { count: changed })}</span>
          ) : (
            <span className="flex items-center gap-1">
              <Check className="size-3.5" />
              {t("gitRepo.shell.statusBar.clean")}
            </span>
          )}
          {conflicts.length > 0 ? (
            <span className="text-destructive flex items-center gap-1">
              <AlertTriangle className="size-3.5" />
              {t("gitRepo.shell.statusBar.conflicts", { count: conflicts.length })}
            </span>
          ) : null}
        </>
      ) : (
        <span>{t("gitRepo.shell.statusBar.noRepository")}</span>
      )}

      <div className="ml-auto flex items-center gap-3">
        {fetchFailures.length > 0 ? (
          <span className="text-destructive flex items-center gap-1">
            <AlertTriangle className="size-3.5" />
            {t("gitRepo.shell.statusBar.fetchFailed", { remotes: fetchFailures.join(", ") })}
          </span>
        ) : null}
        {lastFetchAt && fetchFailures.length === 0 ? (
          <span className="text-muted-foreground/70 truncate">
            {t("gitRepo.shell.statusBar.fetched", { when: timeAgo(lastFetchAt / 1000) })}
          </span>
        ) : null}
        {pullRequestUrl ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void openUrl(pullRequestUrl)}
            className="text-muted-foreground"
          >
            <GitBranchPlus />
            {t("gitRepo.shell.statusBar.createPullRequest")}
          </Button>
        ) : null}
        {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {busy ? <span className="truncate">{busy}</span> : null}
      </div>
    </div>
  );
}
