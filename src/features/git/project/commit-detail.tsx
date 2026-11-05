import { useEffect, useState, type KeyboardEvent } from "react";
import { Copy, Loader2 } from "lucide-react";
import { diffCommitFiles } from "@/commands";
import { Button } from "@/components/ui/button";
import { ChangeMark, statusMeta } from "@/components/git/change-mark";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { CommitFileInfo, CommitInfo } from "@/lib/git-core";
import { basename, dirname, formatDate, timeAgo } from "@/features/git/utils";
import { trackGit } from "./git-console";
import {
  copyFilePath,
  FileContextMenu,
  fileAbsolutePath,
  runDropFileChanges,
  type FileMenuTarget,
} from "./file-context-menu";
import type { ProjectTabOpeners } from "./tab-openers";
import { toast } from "sonner";

const STATUS_LABEL: Record<CommitFileInfo["status"], string> = {
  new: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

/**
 * The right column: one commit's message, identity and changed files.
 *
 * Opening a file hands its diff to the host, which opens it as an editor tab —
 * the detail pane itself never shows a diff.
 */
export function CommitDetail({
  repo,
  commit,
  openers,
}: {
  repo: string | null;
  commit: CommitInfo | null;
  openers: ProjectTabOpeners;
}) {
  const { t } = useAppTranslation();
  const [files, setFiles] = useState<CommitFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
  const oid = commit?.oid ?? null;
  const shortOid = commit?.shortOid ?? null;

  useEffect(() => {
    setFiles([]);
    setError(null);
    if (!repo || !oid) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await trackGit(
          repo,
          `git show --name-status ${shortOid ?? oid}`,
          () => diffCommitFiles(repo, oid),
          (value) => `${value.length} files`
        );
        if (cancelled) return;
        setFiles(list);
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
  }, [repo, oid, shortOid, revision]);

  if (!commit) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm font-medium">{t("gitRepo.inspector.history.pickCommitTitle")}</p>
        <p className="text-muted-foreground text-xs">
          {t("gitRepo.inspector.history.pickCommitHint")}
        </p>
      </div>
    );
  }

  const copyHash = () => {
    void navigator.clipboard.writeText(commit.oid);
    toast.success(t("gitRepo.inspector.commitDetails.hashCopied"));
  };

  const openFileDiff = (file: CommitFileInfo, forceNew = false) =>
    openers.openDiff({
      oid: commit.oid,
      path: file.path,
      oldPath: file.oldPath,
      staged: false,
      forceNew,
    });

  const editSource = (file: CommitFileInfo) => {
    void (async () => {
      if (repo && (await openers.openFile(fileAbsolutePath(repo, file.path)))) return;
      // The working copy may not hold the file any more; the revision does.
      openers.openRevisionFile(commit.oid, file.path);
    })();
  };

  const dropChanges = (file: CommitFileInfo) => {
    if (repo) void runDropFileChanges(repo, file.path, commit.oid, t);
  };

  const onFileKeyDown = (event: KeyboardEvent<HTMLButtonElement>, file: CommitFileInfo) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      openFileDiff(file);
      return;
    }
    if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copyFilePath(file.path, t);
      return;
    }
    if (event.key === "F4") {
      event.preventDefault();
      editSource(file);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      dropChanges(file);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border shrink-0 space-y-2 border-b px-3 py-2.5">
        <p className="text-sm leading-snug font-medium [overflow-wrap:anywhere]">
          {commit.summary}
        </p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="text-foreground truncate">{commit.author.name}</span>
          <span className="truncate">&lt;{commit.author.email}&gt;</span>
          <span title={formatDate(commit.author.time)}>{timeAgo(commit.author.time)}</span>
        </div>
        <div className="flex items-center gap-1">
          <code className="text-muted-foreground font-mono text-[11px]">{commit.shortOid}</code>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("gitRepo.inspector.commitDetails.copyHashHint")}
            title={t("gitRepo.inspector.commitDetails.copyHashHint")}
            onClick={copyHash}
          >
            <Copy className="size-3" />
          </Button>
          {commit.refs.length > 0 && (
            <span className="text-primary ml-1 truncate text-[11px]">
              {commit.refs.map((ref) => ref.shorthand).join(", ")}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {commit.body.trim().length > 0 && (
          <p className="border-border text-muted-foreground border-b px-3 py-2 text-xs whitespace-pre-wrap">
            {commit.body.trim()}
          </p>
        )}

        <div className="border-border flex items-center gap-2 border-b px-3 py-1.5">
          <span className="text-[11px] font-medium tracking-wide uppercase">
            {t("gitRepo.inspector.files.title")}
          </span>
          <span className="text-faint text-[11px]">
            {t("gitRepo.inspector.files.changedCount", { count: files.length })}
          </span>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 px-3 py-3">
            <p className="text-destructive text-[11px] [overflow-wrap:anywhere]">
              {t("gitRepo.inspector.files.loadFailed", { error })}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
              {t("gitRepo.inspector.files.retry")}
            </Button>
          </div>
        ) : files.length === 0 ? (
          <div className="px-3 py-4">
            <p className="text-xs font-medium">{t("gitRepo.inspector.files.emptyTitle")}</p>
            <p className="text-muted-foreground text-[11px]">
              {t("gitRepo.inspector.files.emptyDescription")}
            </p>
          </div>
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
                    onClick={() => openFileDiff(file)}
                    onKeyDown={(event) => onFileKeyDown(event, file)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({
                        point: { x: event.clientX, y: event.clientY },
                        row: {
                          path: file.path,
                          oldPath: file.oldPath,
                          oid: commit.oid,
                          parentOid: commit.parents[0] ?? null,
                          deleted: file.status === "deleted",
                        },
                      });
                    }}
                    className="hover:bg-muted flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs transition-colors"
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
                    <span className="flex-1" />
                    {file.additions > 0 && (
                      <span className="text-success shrink-0 font-mono text-[10px]">
                        +{file.additions}
                      </span>
                    )}
                    {file.deletions > 0 && (
                      <span className="text-destructive shrink-0 font-mono text-[10px]">
                        −{file.deletions}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <FileContextMenu
        repo={repo}
        target={menu}
        headOid={null}
        openers={openers}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}
