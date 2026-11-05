import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import i18n from "@/i18n";
import type { CommitFileInfo, CommitInfo } from "@/lib/git-core";
import { FolderOpen, FolderTree, List, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useGraph } from "@/features/git/graph/store";
import { useRepo } from "@/features/git/repository-store";
import { focusRequests, useUi } from "@/features/git/ui-store";
import { Hint } from "@/features/git/diff/diff-ui";
import { diffCommitFiles, historyCommit, stashFiles } from "@/commands";
import { WorkingCopyPanel } from "@/features/git/commit/WorkingCopyPanel";
import { CommitDetails } from "./CommitDetails";

export function Inspector() {
  const { t } = useAppTranslation();
  const selectedOid = useGraph((s) => s.selectedOid);
  const repoPath = useRepo((s) => s.repo?.path);
  const fileView = useUi((s) => s.fileView);
  const setFileView = useUi((s) => s.setFileView);
  const fileFilterOpen = useUi((s) => s.fileFilterOpen);
  const setFileFilterOpen = useUi((s) => s.setFileFilterOpen);
  const inspectorFocusSeq = useUi((s) => s.inspectorFocusSeq);
  const isStash = useRepo(
    (s) => !!selectedOid && s.stashes.some((entry) => entry.oid === selectedOid)
  );

  const [commit, setCommit] = useState<CommitInfo | null>(null);
  const [diffs, setDiffs] = useState<CommitFileInfo[]>([]);
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [diffsError, setDiffsError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const { centerDiff, closeCenterDiff } = useUi.getState();
    if (centerDiff?.oid && centerDiff.oid !== selectedOid) closeCenterDiff();

    if (!selectedOid || !repoPath) {
      setCommit(null);
      setDiffs([]);
      setCommitError(null);
      setDiffsError(null);
      return;
    }
    const local = useGraph.getState().commits.find((c) => c.oid === selectedOid) ?? null;
    setCommit(local);
    setDiffs([]);
    setCommitError(null);
    setDiffsError(null);
    setLoadingDiffs(true);
    let cancelled = false;
    if (!local) {
      void historyCommit(repoPath, selectedOid)
        .then((info) => {
          if (!cancelled) setCommit(info);
        })
        .catch((error) => {
          if (cancelled) return;
          const message = String((error as { message?: string }).message ?? error);
          toast.error(i18n.t("gitRepo.inspector.loadCommitFailed", { error: message }));
          setCommitError(message);
        });
    }
    const stash = useRepo.getState().stashes.find((s) => s.oid === selectedOid);
    void (stash ? stashFiles(repoPath, stash.index) : diffCommitFiles(repoPath, selectedOid))
      .then((result) => {
        if (!cancelled) setDiffs(result);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiffsError(String((error as { message?: string }).message ?? error));
      })
      .finally(() => {
        if (!cancelled) setLoadingDiffs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOid, repoPath, retrySeq]);

  useEffect(() => {
    if (inspectorFocusSeq === focusRequests.inspectorConsumed) return;
    focusRequests.inspectorConsumed = inspectorFocusSeq;
    rootRef.current?.focus();
  }, [inspectorFocusSeq]);

  const retry = () => setRetrySeq((n) => n + 1);
  const commitState = commit || commitError;

  return (
    <aside
      ref={rootRef}
      tabIndex={-1}
      className="bg-card flex h-full flex-col outline-none"
      aria-label={t("gitRepo.inspector.aria")}
    >
      <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <span className="text-muted-foreground px-1 text-xs font-semibold tracking-wide uppercase">
          {commitState
            ? isStash
              ? t("gitRepo.inspector.label.stash")
              : t("gitRepo.inspector.label.commit")
            : t("gitRepo.inspector.label.workingCopy")}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Hint
            label={
              fileFilterOpen
                ? t("gitRepo.inspector.hideFileFilter")
                : t("gitRepo.inspector.filterFiles")
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                fileFilterOpen
                  ? t("gitRepo.inspector.hideFileFilter")
                  : t("gitRepo.inspector.filterFiles")
              }
              aria-pressed={fileFilterOpen}
              className={cn(fileFilterOpen && "bg-muted text-foreground")}
              onClick={() => setFileFilterOpen(!fileFilterOpen)}
            >
              <Search className="size-3.5" />
            </Button>
          </Hint>
          <span className="bg-border mx-1 h-4 w-px" />
          <Hint label={t("gitRepo.inspector.viewList")}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("gitRepo.inspector.viewList")}
              aria-pressed={fileView === "list"}
              className={cn(fileView === "list" && "bg-muted text-foreground")}
              onClick={() => setFileView("list")}
            >
              <List className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={t("gitRepo.inspector.viewTree")}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("gitRepo.inspector.viewTree")}
              aria-pressed={fileView === "tree"}
              className={cn(fileView === "tree" && "bg-muted text-foreground")}
              onClick={() => setFileView("tree")}
            >
              <FolderTree className="size-3.5" />
            </Button>
          </Hint>
          <Hint
            label={
              commitState
                ? t("gitRepo.inspector.viewAllCommit")
                : t("gitRepo.inspector.viewAllWorking")
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("gitRepo.inspector.viewAll")}
              aria-pressed={fileView === "all"}
              className={cn(fileView === "all" && "bg-muted text-foreground")}
              onClick={() => setFileView("all")}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </Hint>
          {commitState && (
            <>
              <span className="bg-border mx-1 h-4 w-px" />
              <Hint label={t("gitRepo.inspector.backToWorkingCopy")}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("gitRepo.inspector.backToWorkingCopy")}
                  onClick={() => {
                    useUi.getState().closeCenterDiff();
                    useGraph.getState().select(null);
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              </Hint>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {commit ? (
          <CommitDetails
            key={commit.oid}
            commit={commit}
            diffs={diffs}
            loading={loadingDiffs}
            error={diffsError}
            onRetry={retry}
          />
        ) : commitError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">
              {t("gitRepo.inspector.loadCommitFailed", { error: commitError })}
            </p>
            <Button variant="ghost" size="sm" onClick={retry}>
              {t("gitRepo.inspector.retry")}
            </Button>
          </div>
        ) : (
          <WorkingCopyPanel />
        )}
      </div>
    </aside>
  );
}
