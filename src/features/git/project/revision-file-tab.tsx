import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { fileContents } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { DiffViewer } from "@/features/git/diff/diff-viewer";
import type { FileDiff } from "@/lib/git-core";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";

/** One file exactly as a revision holds it, read-only. */
export function RevisionFileTab({
  repo,
  oid,
  path,
}: {
  repo: string | null;
  oid: string;
  path: string;
}) {
  const { t } = useAppTranslation();
  const refreshToken = useGitView((state) => state.refreshToken);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!repo) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await trackGit(
          repo,
          `git show ${oid.slice(0, 7)}:${path}`,
          () => fileContents(repo, path, oid),
          (value) => `${value.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)} lines`
        );
        if (!cancelled) setDiff(result);
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
  }, [repo, oid, path, revision, refreshToken]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3 whitespace-nowrap">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
        <Badge variant="secondary" className="font-mono">
          {oid.slice(0, 8)}
        </Badge>
        <Badge variant="outline">{t("projectGit.revisionFile.readOnly")}</Badge>
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
