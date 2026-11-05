import { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { branchList, tagList } from "@/commands";
import type { BranchInfo, TagInfo } from "@/lib/git-core";
import { BranchesPane } from "./branches-pane";
import { CommitDetail } from "./commit-detail";
import { CommitList } from "./commit-list";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";
import type { ProjectTabOpeners } from "./tab-openers";
import { useCommitHistory } from "./use-commit-history";

/**
 * The tool window's log tab: branches on the left, the commits of the chosen ref
 * in the middle, the selected commit on the right.
 *
 * It has no header of its own — the tab bar above it owns the title and the
 * refresh button, which drives this view through the store's refresh token.
 */
export function GitLogView({ repo, openers }: { repo: string | null; openers: ProjectTabOpeners }) {
  const branch = useGitView((state) => state.branch);
  const currentBranch = useGitView((state) => state.currentBranch);
  const selectedOid = useGitView((state) => state.selectedOid);
  const refreshToken = useGitView((state) => state.refreshToken);
  const setBranch = useGitView((state) => state.setBranch);
  const setCurrentBranch = useGitView((state) => state.setCurrentBranch);
  const selectCommit = useGitView((state) => state.selectCommit);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsError, setRefsError] = useState<string | null>(null);

  const history = useCommitHistory(repo, branch, refreshToken);

  useEffect(() => {
    if (!repo) {
      setBranches([]);
      setTags([]);
      setRefsError(null);
      setRefsLoading(false);
      setCurrentBranch(null);
      return;
    }
    let cancelled = false;
    setRefsLoading(true);
    void (async () => {
      try {
        const [nextBranches, nextTags] = await Promise.all([
          trackGit(
            repo,
            "git branch --list --all",
            () => branchList(repo),
            (list) => `${list.length} branches`
          ),
          trackGit(
            repo,
            "git tag --list",
            () => tagList(repo),
            (list) => `${list.length} tags`
          ),
        ]);
        if (cancelled) return;
        setBranches(nextBranches);
        setTags(nextTags);
        setRefsError(null);
        setCurrentBranch(nextBranches.find((item) => item.isHead)?.name ?? null);
        // A remembered branch may have been deleted since the view was last open.
        const chosen = useGitView.getState().branch;
        const known =
          nextBranches.some((item) => item.name === chosen) ||
          nextTags.some((item) => item.name === chosen);
        if (chosen !== null && !known) setBranch(null);
      } catch (cause) {
        if (cancelled) return;
        setRefsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setRefsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, refreshToken, setBranch, setCurrentBranch]);

  const selectedCommit = history.commits.find((commit) => commit.oid === selectedOid) ?? null;

  return (
    <Group orientation="horizontal" className="h-full min-h-0">
      <Panel id="refs" defaultSize="20" minSize="14" maxSize="42" className="overflow-hidden">
        <BranchesPane
          repo={repo}
          branches={branches}
          tags={tags}
          loading={refsLoading}
          error={refsError}
          selected={branch}
          openers={openers}
          onSelect={setBranch}
          onRetry={() => useGitView.getState().requestRefresh()}
        />
      </Panel>
      <Separator className="bg-border w-px" />
      <Panel id="commits" defaultSize="46" minSize="25" className="overflow-hidden">
        <CommitList
          repo={repo}
          branch={branch}
          currentBranch={currentBranch}
          commits={history.commits}
          rows={history.rows}
          maxLane={history.maxLane}
          selectedOid={selectedOid}
          headBranch={currentBranch}
          loading={history.loading}
          loadingMore={history.loadingMore}
          error={history.error}
          hasMore={history.hasMore}
          openers={openers}
          onSelect={selectCommit}
          onLoadMore={history.loadMore}
          onRetry={history.reload}
        />
      </Panel>
      <Separator className="bg-border w-px" />
      <Panel id="detail" defaultSize="34" minSize="20" className="overflow-hidden">
        <CommitDetail repo={repo} commit={selectedCommit} openers={openers} />
      </Panel>
    </Group>
  );
}
