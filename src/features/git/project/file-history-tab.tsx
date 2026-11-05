import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { historyFile } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { timeAgo } from "@/features/git/utils";
import type { CommitInfo } from "@/lib/git-core";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";
import type { ProjectTabOpeners } from "./tab-openers";

const PAGE = 200;

/** The commits that touched one file, newest first, optionally from a revision. */
export function FileHistoryTab({
  repo,
  path,
  fromOid,
  openers,
}: {
  repo: string | null;
  path: string;
  fromOid?: string;
  openers: ProjectTabOpeners;
}) {
  const { t } = useAppTranslation();
  const refreshToken = useGitView((state) => state.refreshToken);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setCommits([]);
    setTruncated(false);
    setError(null);
    if (!repo) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const page = await trackGit(
          repo,
          `git log ${fromOid ? `${fromOid} ` : ""}-- ${path}`,
          () => historyFile(repo, path, PAGE, 0, fromOid),
          (value) => `${value.commits.length} commits`
        );
        if (cancelled) return;
        setCommits(page.commits);
        setTruncated(page.hasMore);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, path, fromOid, revision, refreshToken]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3 whitespace-nowrap">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
        {fromOid && (
          <Badge variant="secondary" className="font-mono">
            {t("projectGit.fileHistory.from", { oid: fromOid.slice(0, 8) })}
          </Badge>
        )}
        <span className="text-faint text-[11px]">
          {t("projectGit.fileHistory.count", { count: commits.length })}
        </span>
        {error && (
          <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
            {t("gitRepo.diff.panel.retry")}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="text-destructive px-3 py-4 text-sm [overflow-wrap:anywhere]">
            {t("gitRepo.diff.panel.loadError", { message: error })}
          </p>
        ) : commits.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-sm">
            {t("projectGit.fileHistory.empty")}
          </p>
        ) : (
          <>
            <ul>
              {commits.map((commit) => (
                <li key={commit.oid}>
                  <button
                    type="button"
                    title={commit.summary}
                    onClick={() =>
                      openers.openDiff({
                        oid: commit.oid,
                        path,
                        oldPath: null,
                        staged: false,
                      })
                    }
                    className="hover:bg-muted flex w-full flex-col gap-0.5 border-b border-transparent px-3 py-1.5 text-left transition-colors last:border-b-0"
                  >
                    <span className="w-full truncate text-xs">{commit.summary}</span>
                    <span className="text-faint flex w-full items-center gap-2 text-[11px]">
                      <code className="font-mono">{commit.shortOid}</code>
                      <span className="min-w-0 truncate">{commit.author.name}</span>
                      <span className="shrink-0">{timeAgo(commit.author.time)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {truncated && (
              <p className="text-faint border-border border-t px-3 py-1 text-[11px]">
                {t("projectGit.fileHistory.truncated", { count: commits.length })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
