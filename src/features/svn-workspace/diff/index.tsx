import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Diff, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { revealWorkspaceFile, svnDiff } from "@/commands";
import { writeClipboardText } from "@/lib/svn-core/clipboard";
import type { DiffResult } from "@/lib/svn-core/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyPane } from "@/components/svn-workspace/empty-pane";
import { DiffViewer, type DiffStats } from "@/components/svn-workspace/diff-viewer";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { isWorkspaceRelativePath } from "@/features/svn-workspace/log/model";

/** Parse a revision input; blank means "the working copy" and is left undefined. */
function parseRevision(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

/**
 * The diff panel: one file's unified diff, handed over by `openDiff` from the
 * changes, commit, update, review or log panels. The reference's `DiffView` also
 * had a three-way mode selector (working copy / revision range / a single
 * change); only the first two reach `svn diff` here, so the panel exposes a
 * revision-range comparison with the working copy as the default. It never
 * renders the diff itself — that is `DiffViewer`'s job.
 */
export function DiffPanel() {
  const { t } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((state) => state.workspacePath);
  const diffTarget = useSvnWorkspaceStore((state) => state.diffTarget);

  const [oldInput, setOldInput] = useState("");
  const [newInput, setNewInput] = useState("");
  const [result, setResult] = useState<DiffResult | null>(null);
  const [requested, setRequested] = useState<{ oldRev?: number; newRev?: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DiffStats | null>(null);

  const generation = useRef(0);

  const runDiff = useCallback(
    async (path: string, oldRev?: number, newRev?: number) => {
      if (!workspacePath) return;
      const id = ++generation.current;
      setLoading(true);
      setStats(null);
      try {
        const next = await svnDiff(workspacePath, path, oldRev, newRev);
        if (id !== generation.current) return;
        setResult(next);
        setRequested({ oldRev, newRev });
        setError(null);
      } catch (err) {
        if (id !== generation.current) return;
        setResult(null);
        setError(String(err));
      } finally {
        if (id === generation.current) setLoading(false);
      }
    },
    [workspacePath]
  );

  // A new diff target (a different file, or a different revision hand-off)
  // restarts the whole panel in the target's default range.
  const targetKey = diffTarget
    ? `${diffTarget.path}|${diffTarget.oldRevision ?? ""}|${diffTarget.newRevision ?? ""}`
    : "";
  useEffect(() => {
    generation.current += 1;
    setStats(null);
    if (!diffTarget || !workspacePath) {
      setResult(null);
      setRequested(null);
      setError(null);
      setLoading(false);
      return;
    }
    setOldInput(diffTarget.oldRevision != null ? String(diffTarget.oldRevision) : "");
    setNewInput(diffTarget.newRevision != null ? String(diffTarget.newRevision) : "");
    void runDiff(diffTarget.path, diffTarget.oldRevision, diffTarget.newRevision);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, workspacePath]);

  const compare = () => {
    if (!diffTarget || loading) return;
    const oldRev = parseRevision(oldInput);
    const newRev = parseRevision(newInput);
    if (Number.isNaN(oldRev as number) || Number.isNaN(newRev as number)) {
      setError(t("svnWorkspace.diff.invalidRevision"));
      return;
    }
    void runDiff(diffTarget.path, oldRev, newRev);
  };

  const copyPath = async () => {
    if (!diffTarget) return;
    try {
      await writeClipboardText(diffTarget.path);
      toast.success(t("svnWorkspace.diff.toast.pathCopied"));
    } catch {
      toast.error(t("svnWorkspace.diff.toast.copyFailed"));
    }
  };

  const reveal = () => {
    if (!workspacePath || !diffTarget) return;
    if (!isWorkspaceRelativePath(diffTarget.path)) return;
    void revealWorkspaceFile(workspacePath, diffTarget.path).catch((err) => {
      toast.error(t("svnWorkspace.common.error"), { description: String(err) });
      console.error("Failed to reveal the diff path:", err);
    });
  };

  if (!diffTarget) {
    return (
      <EmptyPane
        icon={Diff}
        title={t("svnWorkspace.diff.noTarget")}
        description={t("svnWorkspace.diff.noTargetHint")}
      />
    );
  }

  const revealable = isWorkspaceRelativePath(diffTarget.path);
  const workingCopy = requested != null && requested.newRev === undefined;
  const rangeLabel =
    requested == null
      ? null
      : workingCopy
        ? t("svnWorkspace.diff.workingCopy")
        : t("svnWorkspace.diff.revisionRange", {
            old: result?.oldRevision ?? requested.oldRev ?? 0,
            new: result?.newRevision ?? requested.newRev ?? 0,
          });
  const empty = result !== null && result.diff.trim().length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex flex-col gap-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <Diff className="size-3.5 shrink-0" />
            <span className="truncate font-mono" title={diffTarget.path}>
              {diffTarget.path}
            </span>
          </span>
          {rangeLabel ? (
            <span className="border-border text-faint shrink-0 rounded border px-1.5 py-px text-xs tabular-nums">
              {rangeLabel}
            </span>
          ) : null}
          {stats ? (
            <span className="text-faint shrink-0 text-xs tabular-nums">
              <span className="text-success">+{stats.added}</span>{" "}
              <span className="text-destructive">-{stats.removed}</span>
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("svnWorkspace.diff.copyPath")}
              title={t("svnWorkspace.diff.copyPath")}
              onClick={() => void copyPath()}
            >
              <Copy className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!revealable}
              aria-label={t("svnWorkspace.diff.reveal")}
              title={t("svnWorkspace.diff.reveal")}
              onClick={reveal}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-faint">{t("svnWorkspace.diff.oldRevision")}</span>
          <Input
            value={oldInput}
            onChange={(event) => setOldInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") compare();
            }}
            placeholder={t("svnWorkspace.diff.workingCopy")}
            aria-label={t("svnWorkspace.diff.oldRevision")}
            inputMode="numeric"
            className="h-8 w-24 text-xs tabular-nums"
          />
          <span className="text-faint">→</span>
          <span className="text-faint">{t("svnWorkspace.diff.newRevision")}</span>
          <Input
            value={newInput}
            onChange={(event) => setNewInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") compare();
            }}
            placeholder={t("svnWorkspace.diff.workingCopy")}
            aria-label={t("svnWorkspace.diff.newRevision")}
            inputMode="numeric"
            className="h-8 w-24 text-xs tabular-nums"
          />
          <Button size="sm" className="h-8" disabled={loading} onClick={compare}>
            {t("svnWorkspace.diff.compare")}
          </Button>
          <span className="text-faint">{t("svnWorkspace.diff.betweenRevisions")}</span>
        </div>
      </div>

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-1.5 border-b px-3 py-1 text-xs">
          <span className="truncate" title={error}>
            {t("svnWorkspace.diff.error")} {error}
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={loading}>
        {loading && !result ? (
          <EmptyPane loading title={t("svnWorkspace.diff.loading")} />
        ) : empty ? (
          <EmptyPane
            icon={Diff}
            title={t("svnWorkspace.diff.empty")}
            description={t("svnWorkspace.diff.emptyHint")}
          />
        ) : result ? (
          <DiffViewer diff={result.diff} onStats={setStats} />
        ) : null}
      </div>
    </div>
  );
}

export default DiffPanel;
