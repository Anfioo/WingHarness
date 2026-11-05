import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, FolderOpen, UserRoundSearch } from "lucide-react";
import { toast } from "sonner";
import { revealWorkspaceFile, svnBlame } from "@/commands";
import { writeClipboardText } from "@/lib/svn-core/clipboard";
import type { BlameLine } from "@/lib/svn-core/types";
import { Button } from "@/components/ui/button";
import { EmptyPane } from "@/components/svn-workspace/empty-pane";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 22;

/**
 * The blame panel: `svn blame` for the file handed over by `openBlame`, one row
 * per line with its revision, author and text. The reference's `BlameView` was a
 * flat table with no date column and no per-author colouring, so this keeps to
 * that: the only grouping cue is a boundary line wherever the revision changes.
 * Rows are virtualized for large files, and each carries the reference's
 * per-line actions (item E: view that revision's diff, copy the revision/author).
 */
export function BlamePanel() {
  const { t } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((state) => state.workspacePath);
  const blameTarget = useSvnWorkspaceStore((state) => state.blameTarget);
  const openDiff = useSvnWorkspaceStore((state) => state.openDiff);

  const [lines, setLines] = useState<BlameLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const id = generation.current;
    setLines([]);
    setError(null);
    if (!blameTarget || !workspacePath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void svnBlame(workspacePath, blameTarget)
      .then((result) => {
        if (id === generation.current) setLines(result);
      })
      .catch((err) => {
        if (id === generation.current) setError(String(err));
      })
      .finally(() => {
        if (id === generation.current) setLoading(false);
      });
  }, [blameTarget, workspacePath]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [blameTarget]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const copy = useCallback(
    async (value: string, key: string) => {
      try {
        await writeClipboardText(value);
        toast.success(t(key));
      } catch {
        toast.error(t("svnWorkspace.blame.toast.copyFailed"));
      }
    },
    [t]
  );

  const openRevisionDiff = (revision: number) => {
    if (!blameTarget || revision <= 0) return;
    openDiff({ path: blameTarget, oldRevision: revision - 1, newRevision: revision });
  };

  const copyPath = () => {
    if (!blameTarget) return;
    void copy(blameTarget, "svnWorkspace.blame.toast.pathCopied");
  };

  const reveal = () => {
    if (!workspacePath || !blameTarget) return;
    void revealWorkspaceFile(workspacePath, blameTarget).catch((err) => {
      toast.error(t("svnWorkspace.common.error"), { description: String(err) });
      console.error("Failed to reveal the blamed file:", err);
    });
  };

  if (!blameTarget) {
    return (
      <EmptyPane
        icon={UserRoundSearch}
        title={t("svnWorkspace.blame.noTarget")}
        description={t("svnWorkspace.blame.noTargetHint")}
      />
    );
  }

  const items = virtualizer.getVirtualItems();
  const showBlockingLoader = loading && lines.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <UserRoundSearch className="size-3.5 shrink-0" />
          <span className="truncate font-mono" title={blameTarget}>
            {blameTarget}
          </span>
        </span>
        <span className="text-faint shrink-0 text-xs" aria-live="polite">
          {t("svnWorkspace.blame.lines", { count: lines.length })}
        </span>
        {loading && lines.length > 0 ? (
          <span className="text-primary shrink-0 text-xs">{t("svnWorkspace.common.loading")}</span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("svnWorkspace.blame.copyPath")}
            title={t("svnWorkspace.blame.copyPath")}
            onClick={copyPath}
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("svnWorkspace.blame.reveal")}
            title={t("svnWorkspace.blame.reveal")}
            onClick={reveal}
          >
            <FolderOpen className="size-3.5" />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-1.5 border-b px-3 py-1 text-xs">
          <span className="truncate" title={error}>
            {t("svnWorkspace.blame.error")} {error}
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={loading}>
        {showBlockingLoader ? (
          <EmptyPane loading title={t("svnWorkspace.blame.loading")} />
        ) : lines.length > 0 ? (
          <>
            <div className="text-faint bg-muted/30 border-border grid shrink-0 grid-cols-[56px_84px_150px_minmax(0,1fr)] border-b px-2 py-1 text-[11px] font-medium tracking-wide uppercase">
              <span className="text-right">{t("svnWorkspace.blame.line")}</span>
              <span className="pl-2">{t("svnWorkspace.blame.revision")}</span>
              <span className="pl-2">{t("svnWorkspace.blame.author")}</span>
              <span className="pl-2">{t("svnWorkspace.blame.content")}</span>
            </div>
            <div
              ref={scrollRef}
              role="table"
              aria-label={t("svnWorkspace.blame.title")}
              aria-rowcount={lines.length}
              className="min-h-0 flex-1 overflow-auto font-mono text-xs"
            >
              <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {items.map((item) => {
                  const line = lines[item.index];
                  if (!line) return null;
                  const previous = item.index > 0 ? lines[item.index - 1] : null;
                  const startsGroup = !previous || previous.revision !== line.revision;
                  return (
                    <div
                      key={item.key}
                      role="row"
                      aria-rowindex={item.index + 1}
                      className={cn(
                        "group hover:bg-muted/40 absolute left-0 grid w-full grid-cols-[56px_84px_150px_minmax(0,1fr)] items-center px-2",
                        startsGroup && "border-border border-t"
                      )}
                      style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                    >
                      <span className="text-faint pr-2 text-right tabular-nums select-none">
                        {item.index + 1}
                      </span>
                      <span className="min-w-0 truncate pl-2">
                        <button
                          type="button"
                          disabled={line.revision <= 0}
                          className="rounded px-1 font-medium hover:underline disabled:no-underline disabled:opacity-70"
                          title={t("svnWorkspace.blame.openDiff")}
                          onClick={() => openRevisionDiff(line.revision)}
                        >
                          r{line.revision}
                        </button>
                      </span>
                      <span
                        className="text-muted-foreground min-w-0 truncate pl-2"
                        title={line.author}
                      >
                        {line.author || "—"}
                      </span>
                      <span className="group/line flex min-w-0 items-center gap-1">
                        <span className="min-w-0 flex-1 truncate" title={line.line}>
                          {line.line || " "}
                        </span>
                        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t("svnWorkspace.blame.copyRevision")}
                            title={t("svnWorkspace.blame.copyRevision")}
                            onClick={() =>
                              void copy(
                                String(line.revision),
                                "svnWorkspace.blame.toast.revisionCopied"
                              )
                            }
                          >
                            <Copy className="size-3" />
                          </Button>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <EmptyPane
            icon={UserRoundSearch}
            title={t("svnWorkspace.blame.empty")}
            description={t("svnWorkspace.blame.emptyHint")}
          />
        )}
      </div>
    </div>
  );
}

export default BlamePanel;
