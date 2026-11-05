import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { diffCommitFile, diffFile } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { FileDiff } from "@/lib/git-core";
import type { DiffTabTarget } from "@/lib/editor/editor-tabs";
import { useUi } from "@/features/git/ui-store";
import { DiffViewer } from "@/features/git/diff/diff-viewer";
import { DiffViewControls } from "@/features/git/diff/diff-view-controls";
import { wrapUnavailable } from "@/features/git/diff/diff-shared";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";

/** Context large enough that a "whole file" diff is effectively untruncated. */
const WHOLE_FILE_CONTEXT = 10_000_000;

/**
 * One file's diff, as an editor tab.
 *
 * The tab strip's title says which commit and file; this is only the header
 * that no tab strip shows — path, side, line counts — and the diff itself.
 */
export function DiffTab({ repo, target }: { repo: string | null; target: DiffTabTarget }) {
  const { t } = useAppTranslation();
  const ignoreWhitespace = useUi((state) => state.ignoreWhitespace);
  const fullFileDiff = useUi((state) => state.fullFileDiff);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const refreshToken = useGitView((state) => state.refreshToken);

  useEffect(() => {
    if (!repo) {
      setDiff(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const contextLines = fullFileDiff ? WHOLE_FILE_CONTEXT : undefined;
    const command = target.oid
      ? `git show ${target.oid.slice(0, 7)} -- ${target.path}`
      : target.staged
        ? `git diff --cached -- ${target.path}`
        : `git diff -- ${target.path}`;
    const load = () =>
      target.oid
        ? diffCommitFile(
            repo,
            target.oid,
            target.path,
            target.oldPath ?? undefined,
            contextLines,
            ignoreWhitespace
          )
        : diffFile(repo, target.path, target.staged, contextLines, ignoreWhitespace);
    void (async () => {
      try {
        const result = await trackGit(
          repo,
          command,
          load,
          (value) => `${value.path}: +${value.additions} −${value.deletions}`
        );
        if (!cancelled) setDiff(result);
      } catch (cause) {
        if (cancelled) return;
        setDiff(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    repo,
    target.oid,
    target.path,
    target.oldPath,
    target.staged,
    ignoreWhitespace,
    fullFileDiff,
    revision,
    refreshToken,
  ]);

  const textDiff = diff && !diff.isBinary && !diff.isImage ? diff : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3 whitespace-nowrap">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {target.oldPath ? `${target.oldPath} → ${target.path}` : target.path}
        </span>
        {target.oid ? (
          <Badge variant="secondary" className="font-mono">
            {target.oid.slice(0, 8)}
          </Badge>
        ) : (
          <Badge variant="outline" className={target.staged ? "text-success" : "text-info"}>
            {target.staged ? t("gitRepo.diff.panel.staged") : t("gitRepo.diff.panel.unstaged")}
          </Badge>
        )}
        {diff && (
          <span className="shrink-0 text-xs">
            <span className="text-success">+{diff.additions}</span>{" "}
            <span className="text-destructive">−{diff.deletions}</span>
          </span>
        )}
        {error && (
          <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
            {t("gitRepo.diff.panel.retry")}
          </Button>
        )}
        <DiffViewControls wrapDisabled={!!textDiff && wrapUnavailable(textDiff)} />
      </div>

      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
            <p className="text-destructive max-w-md text-center text-sm [overflow-wrap:anywhere]">
              {t("gitRepo.diff.panel.loadError", { message: error })}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
              {t("gitRepo.diff.panel.retry")}
            </Button>
          </div>
        ) : diff ? (
          <DiffViewer diff={diff} scrollRef={scrollRef} />
        ) : null}
      </div>
    </div>
  );
}
