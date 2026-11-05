import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { diffRefFile, diffRefFiles, diffRefWorkdirFile, diffRefWorkdirFiles } from "@/commands";
import { Button } from "@/components/ui/button";
import { ChangeMark, statusMeta } from "@/components/git/change-mark";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { DiffViewer } from "@/features/git/diff/diff-viewer";
import { basename, dirname } from "@/features/git/utils";
import type { CommitFileInfo, FileDiff } from "@/lib/git-core";
import { cn } from "@/lib/utils";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";

const STATUS_LABEL: Record<CommitFileInfo["status"], string> = {
  new: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

/**
 * Two revisions side by side, or one revision against the working tree when
 * `right` is null: the changed files on the left, the picked file's diff on the
 * right. Refs, tags and oids are all accepted, since the backend rev-parses them.
 */
export function CompareTab({
  repo,
  left,
  right,
  path,
}: {
  repo: string | null;
  left: string;
  right: string | null;
  path?: string;
}) {
  const { t } = useAppTranslation();
  const refreshToken = useGitView((state) => state.refreshToken);
  const [files, setFiles] = useState<CommitFileInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(path ?? null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const target = right ?? null;
  const title = `${left} → ${target ?? t("projectGit.workingTree")}`;

  useEffect(() => {
    setFiles([]);
    setError(null);
    setSelected(path ?? null);
    if (!repo) {
      setLoadingFiles(false);
      return;
    }
    let cancelled = false;
    setLoadingFiles(true);
    void (async () => {
      try {
        const list = await trackGit(
          repo,
          target === null ? `git diff ${left}` : `git diff ${left} ${target}`,
          () =>
            target === null ? diffRefWorkdirFiles(repo, left) : diffRefFiles(repo, left, target),
          (value) => `${value.length} files`
        );
        if (cancelled) return;
        setFiles(list);
        setSelected((current) => {
          if (current && list.some((file) => file.path === current)) return current;
          return list[0]?.path ?? null;
        });
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, left, target, path, revision, refreshToken]);

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    const file = files.find((entry) => entry.path === selected);
    if (!repo || !file) {
      setLoadingDiff(false);
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    void (async () => {
      try {
        const result = await trackGit(
          repo,
          `git diff ${left}${target === null ? "" : ` ${target}`} -- ${file.path}`,
          () =>
            target === null
              ? diffRefWorkdirFile(repo, left, file.path, file.oldPath ?? undefined)
              : diffRefFile(repo, left, target, file.path, file.oldPath ?? undefined),
          (value) => `${value.path}: +${value.additions} −${value.deletions}`
        );
        if (!cancelled) setDiff(result);
      } catch (cause) {
        if (cancelled) return;
        setDiffError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoadingDiff(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, left, target, selected, files, refreshToken]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3 whitespace-nowrap">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{title}</span>
        <span className="text-faint text-[11px]">
          {t("gitRepo.inspector.files.changedCount", { count: files.length })}
        </span>
        {error && (
          <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
            {t("gitRepo.diff.panel.retry")}
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="border-border w-64 min-w-40 shrink-0 overflow-y-auto border-r">
          {loadingFiles ? (
            <div className="flex justify-center py-6">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : error ? (
            <p className="text-destructive px-2 py-3 text-[11px] [overflow-wrap:anywhere]">
              {t("gitRepo.diff.panel.loadError", { message: error })}
            </p>
          ) : files.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-[11px]">
              {t("projectGit.compare.empty")}
            </p>
          ) : (
            <ul>
              {files.map((file) => {
                const meta = statusMeta[file.status];
                const dir = dirname(file.path);
                return (
                  <li key={`${file.oldPath ?? ""}:${file.path}`}>
                    <button
                      type="button"
                      title={file.path}
                      onClick={() => setSelected(file.path)}
                      className={cn(
                        "flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs transition-colors",
                        selected === file.path
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      <ChangeMark
                        tone={meta.tone}
                        title={t(`gitRepo.inspector.status.${STATUS_LABEL[file.status]}`)}
                      >
                        {meta.mark}
                      </ChangeMark>
                      {dir && (
                        <span dir="rtl" className="text-faint min-w-0 truncate">
                          <bdi>{dir}/</bdi>
                        </span>
                      )}
                      <span className="min-w-0 shrink-0 truncate">{basename(file.path)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {loadingDiff ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
          ) : diffError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
              <p className="text-destructive max-w-md text-center text-sm [overflow-wrap:anywhere]">
                {t("gitRepo.diff.panel.loadError", { message: diffError })}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
                {t("gitRepo.diff.panel.retry")}
              </Button>
            </div>
          ) : diff ? (
            <DiffViewer diff={diff} scrollRef={scrollRef} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground text-sm">{t("projectGit.compare.pickFile")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
