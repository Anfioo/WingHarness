import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { treeFiles } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { basename, dirname } from "@/features/git/utils";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";
import type { ProjectTabOpeners } from "./tab-openers";

/** Every file a revision holds; picking one opens its content read-only. */
export function RevisionTreeTab({
  repo,
  oid,
  openers,
}: {
  repo: string | null;
  oid: string;
  openers: ProjectTabOpeners;
}) {
  const { t } = useAppTranslation();
  const refreshToken = useGitView((state) => state.refreshToken);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setFiles([]);
    setError(null);
    if (!repo) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await trackGit(
          repo,
          `git ls-tree -r --name-only ${oid.slice(0, 7)}`,
          () => treeFiles(repo, oid),
          (value) => `${value.length} files`
        );
        if (!cancelled) setFiles(list);
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
  }, [repo, oid, revision, refreshToken]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3 whitespace-nowrap">
        <span className="min-w-0 flex-1 truncate text-xs">
          {t("projectGit.revisionTree.title")}
        </span>
        <Badge variant="secondary" className="font-mono">
          {oid.slice(0, 8)}
        </Badge>
        <span className="text-faint text-[11px]">
          {t("projectGit.revisionTree.fileCount", { count: files.length })}
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
        ) : files.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-sm">
            {t("projectGit.revisionTree.empty")}
          </p>
        ) : (
          <ul>
            {files.map((file) => {
              const dir = dirname(file);
              return (
                <li key={file}>
                  <button
                    type="button"
                    title={file}
                    onClick={() => openers.openRevisionFile(oid, file)}
                    className="hover:bg-muted flex h-7 w-full items-center gap-1.5 px-3 text-left text-xs transition-colors"
                  >
                    <FileText className="text-muted-foreground size-3.5 shrink-0" />
                    {dir && (
                      <span dir="rtl" className="text-faint min-w-0 truncate">
                        <bdi>{dir}/</bdi>
                      </span>
                    )}
                    <span className="min-w-0 shrink-0 truncate">{basename(file)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
