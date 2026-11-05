import { useCallback, useEffect, useRef, useState } from "react";
import { historyList } from "@/commands";
import { GraphLayout, type CommitInfo, type GraphRow } from "@/lib/git-core";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";

const PAGE = 200;

/** The log query as the git CLI would spell it, for the console. */
function logCommand(branch: string | null, skip: number): string {
  return `git log ${branch ?? "--all"} --skip ${skip} --max-count ${PAGE}`;
}

export interface CommitHistory {
  commits: readonly CommitInfo[];
  rows: readonly GraphRow[];
  maxLane: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
}

/**
 * The commit list the Git tab shows, one page at a time.
 *
 * The lanes are built as pages arrive: the layout assigns a commit's lane from
 * the ones already on screen, so the graph cannot be laid out per page.
 */
export function useCommitHistory(
  repo: string | null,
  branch: string | null,
  refreshToken = 0
): CommitHistory {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [rows, setRows] = useState<readonly GraphRow[]>([]);
  const [maxLane, setMaxLane] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const layoutRef = useRef(new GraphLayout());
  // A page is in flight: a second load-more or reload would interleave pages.
  const busyRef = useRef(false);
  // Bumped whenever the query changes, so an older page can tell it is stale.
  const generation = useRef(0);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const current = ++generation.current;
    const layout = new GraphLayout();
    layoutRef.current = layout;
    setCommits([]);
    setRows([]);
    setMaxLane(0);
    setHasMore(false);
    setError(null);

    if (!repo) {
      setLoading(false);
      return;
    }

    busyRef.current = true;
    setLoading(true);
    void (async () => {
      try {
        const page = await trackGit(
          repo,
          logCommand(branch, 0),
          () => historyList(repo, { skip: 0, limit: PAGE, branch: branch ?? undefined }),
          (value) => `${value.commits.length} commits`
        );
        if (current !== generation.current) return;
        layout.add(page.commits);
        setCommits(page.commits);
        setRows(layout.getRows());
        setMaxLane(layout.maxLane);
        setHasMore(page.hasMore);
        if (page.commits.length > 0 && !useGitView.getState().selectedOid) {
          useGitView.getState().selectCommit(page.commits[0].oid);
        }
      } catch (cause) {
        if (current !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (current === generation.current) {
          busyRef.current = false;
          setLoading(false);
        }
      }
    })();
  }, [repo, branch, revision, refreshToken]);

  const loadMore = useCallback(() => {
    if (!repo || busyRef.current || !hasMore) return;
    const layout = layoutRef.current;
    const current = generation.current;
    busyRef.current = true;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await trackGit(
          repo,
          logCommand(branch, layout.rowCount),
          () =>
            historyList(repo, {
              skip: layout.rowCount,
              limit: PAGE,
              branch: branch ?? undefined,
            }),
          (value) => `${value.commits.length} commits`
        );
        if (current !== generation.current) return;
        layout.add(page.commits);
        setCommits((existing) => [...existing, ...page.commits]);
        setRows(layout.getRows());
        setMaxLane(layout.maxLane);
        setHasMore(page.hasMore);
      } catch (cause) {
        if (current !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (current === generation.current) {
          busyRef.current = false;
          setLoadingMore(false);
        }
      }
    })();
  }, [repo, branch, hasMore]);

  return { commits, rows, maxLane, hasMore, loading, loadingMore, error, loadMore, reload };
}
