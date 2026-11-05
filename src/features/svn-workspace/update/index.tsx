import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  Eraser,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { svnCleanup, svnLog, svnRemoteInfo, svnUpdate } from "@/commands";
import type { SvnLogEntry } from "@/lib/svn-core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmDialog } from "@/components/confirm";
import { StatusBadge } from "@/components/svn-workspace/status-badge";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useSvnWorkspace } from "@/features/svn-workspace/use-workspace";
import { useSvnSettings } from "@/features/svn-workspace/settings";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/**
 * The update panel: how far the working copy is behind the repository, update to
 * latest or to a pinned revision, and the recovery action (`svn cleanup`) for a
 * stale lock. Mirrors the reference `UpdateView.vue`: a revision strip, the
 * incoming revisions from `svn log`, and the local change list.
 *
 * The engine's `svn_update` resolves once the command completes, so this panel
 * shows a progress indicator while it runs and the command's `CommandResult.output`
 * when it returns. A failed update surfaces a one-click `svn cleanup`.
 */
export function UpdatePanel() {
  const { t, language } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((s) => s.workspacePath);
  const svnInfo = useSvnWorkspaceStore((s) => s.svnInfo);
  const statusList = useSvnWorkspaceStore((s) => s.statusList);
  const statusIsStale = useSvnWorkspaceStore((s) => s.statusIsStale);
  const setError = useSvnWorkspaceStore((s) => s.setError);
  const openDiff = useSvnWorkspaceStore((s) => s.openDiff);
  const { settings } = useSvnSettings();
  const { refreshStatus, refreshStatusAfterMutation } = useSvnWorkspace();

  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [remoteRevision, setRemoteRevision] = useState(0);
  const [incoming, setIncoming] = useState<SvnLogEntry[]>([]);
  const [revisionInput, setRevisionInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setLocalError] = useState<string | null>(null);

  const generation = useRef(0);

  const localRevision = svnInfo?.revision ?? 0;
  const localChanges = useMemo(
    () => statusList.filter((entry) => entry.statusCode !== "normal" && entry.statusCode !== ""),
    [statusList]
  );

  const busy = checking || updating || cleaning;

  const loadState = useCallback(
    async (force: boolean) => {
      if (!workspacePath) return;
      const requested = workspacePath;
      const run = ++generation.current;
      const isCurrent = () =>
        run === generation.current && useSvnWorkspaceStore.getState().workspacePath === requested;

      setChecking(true);
      try {
        await (force ? refreshStatusAfterMutation() : refreshStatus());
        if (!isCurrent()) return;
        const info = await svnRemoteInfo(requested);
        if (!isCurrent()) return;
        setRemoteRevision(info.revision);
        const local = useSvnWorkspaceStore.getState().svnInfo?.revision ?? 0;
        if (info.revision > local) {
          const logs = await svnLog(requested, {
            limit: settings.logLimit || 50,
            startRev: info.revision,
            endRev: local + 1,
          });
          if (!isCurrent()) return;
          setIncoming(logs);
        } else {
          setIncoming([]);
        }
        setLocalError(null);
      } catch (err) {
        if (!isCurrent()) return;
        setLocalError(String(err));
        setError(String(err));
      } finally {
        if (run === generation.current) setChecking(false);
      }
    },
    [workspacePath, refreshStatus, refreshStatusAfterMutation, settings.logLimit, setError]
  );

  // Load on mount and whenever the working copy changes.
  useEffect(() => {
    if (!workspacePath) return;
    void loadState(false);
    return () => {
      generation.current += 1;
    };
  }, [workspacePath, loadState]);

  const runUpdate = useCallback(
    async (revision?: number) => {
      if (!workspacePath || busy) return;
      const pinned = revision !== undefined;
      if (pinned && (!Number.isFinite(revision) || revision <= 0)) {
        toast.error(t("svnWorkspace.update.invalidRevision"));
        return;
      }
      setUpdating(true);
      setOutput("");
      setLocalError(null);
      try {
        const result = await svnUpdate(workspacePath, pinned ? revision : undefined);
        setOutput(result.output);
        await loadState(true);
        toast.success(t("svnWorkspace.update.toast.success"));
      } catch (err) {
        setLocalError(String(err));
        setError(String(err));
        setOutput(`${t("svnWorkspace.common.error")}: ${String(err)}`);
        toast.error(t("svnWorkspace.update.toast.failed", { error: String(err) }));
      } finally {
        setUpdating(false);
      }
    },
    [workspacePath, busy, loadState, setError, t]
  );

  const requestUpdate = useCallback(
    async (pinned: boolean) => {
      if (!workspacePath || busy) return;
      const parsed = pinned ? Number.parseInt(revisionInput.trim(), 10) : undefined;
      if (pinned && !Number.isFinite(parsed)) {
        toast.error(t("svnWorkspace.update.invalidRevision"));
        return;
      }
      const ok = await confirmDialog({
        title: t("svnWorkspace.update.confirm.title"),
        description: pinned
          ? t("svnWorkspace.update.confirm.descriptionRevision", { revision: parsed as number })
          : t("svnWorkspace.update.confirm.description"),
        confirmLabel: t("svnWorkspace.common.update"),
      });
      if (!ok) return;
      await runUpdate(pinned ? (parsed as number) : undefined);
    },
    [workspacePath, busy, revisionInput, runUpdate, t]
  );

  const runCleanup = useCallback(async () => {
    if (!workspacePath || busy) return;
    setCleaning(true);
    setOutput("");
    try {
      const result = await svnCleanup(workspacePath);
      setOutput(result.output);
      await loadState(true);
      setLocalError(null);
      toast.success(t("svnWorkspace.update.cleanup.success"));
    } catch (err) {
      setLocalError(String(err));
      toast.error(t("svnWorkspace.update.cleanup.failed", { error: String(err) }));
    } finally {
      setCleaning(false);
    }
  }, [workspacePath, busy, loadState, t]);

  const formatDate = (date: string) => (date ? new Date(date).toLocaleString(language) : "");

  if (!workspacePath) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
        {t("svnWorkspace.common.noWorkspace")}
      </div>
    );
  }

  const behind = remoteRevision > localRevision;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <ArrowDownToLine className="text-muted-foreground size-4" />
          {t("svnWorkspace.update.title")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadState(true)}>
            <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
            {t("svnWorkspace.update.check")}
          </Button>
          <Input
            value={revisionInput}
            onChange={(event) => setRevisionInput(event.target.value.replace(/[^0-9]/g, ""))}
            placeholder={t("svnWorkspace.update.revisionPlaceholder")}
            aria-label={t("svnWorkspace.update.revisionPlaceholder")}
            inputMode="numeric"
            className="h-8 w-24 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !revisionInput.trim()}
            onClick={() => void requestUpdate(true)}
          >
            {t("svnWorkspace.update.updateToRevision")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void requestUpdate(false)}>
            {updating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowDownToLine className="size-3.5" />
            )}
            {t("svnWorkspace.update.updateLatest")}
          </Button>
        </div>
      </div>

      {statusIsStale ? (
        <div
          className="border-border bg-muted/40 text-muted-foreground border-b px-3 py-1 text-xs"
          role="status"
        >
          {t("svnWorkspace.common.staleStatus")}
        </div>
      ) : null}

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words" title={error}>
            {error}
          </span>
          <Button variant="outline" size="xs" disabled={busy} onClick={() => void runCleanup()}>
            {cleaning ? <Loader2 className="size-3 animate-spin" /> : <Eraser className="size-3" />}
            {t("svnWorkspace.update.cleanup.label")}
          </Button>
        </div>
      ) : null}

      {updating || cleaning ? (
        <div
          className="border-border text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-xs"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin" />
          {cleaning ? t("svnWorkspace.update.cleanup.label") : t("svnWorkspace.common.loading")}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
        <Stat
          label={t("svnWorkspace.update.localRevision")}
          value={localRevision ? `r${localRevision}` : "—"}
        />
        <Stat
          label={t("svnWorkspace.update.remoteRevision")}
          value={remoteRevision ? `r${remoteRevision}` : "—"}
        />
        <Stat label={t("svnWorkspace.update.incomingCount")} value={String(incoming.length)} />
        <Stat
          label={t("svnWorkspace.update.localChangeCount")}
          value={String(localChanges.length)}
        />
      </div>

      {!checking && !behind ? (
        <div className="border-border bg-success/5 text-success mx-3 mb-2 flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs">
          <CheckCircle2 className="size-3.5 shrink-0" />
          {t("svnWorkspace.update.upToDate")}
        </div>
      ) : null}

      <section className="px-3 pb-2">
        <div className="mb-1.5 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">{t("svnWorkspace.update.incomingTitle")}</h3>
          <span className="text-muted-foreground text-[11px]">
            {t("svnWorkspace.update.incomingHint")}
          </span>
        </div>
        {incoming.length > 0 ? (
          <div className="border-border overflow-auto rounded-md border" style={{ maxHeight: 280 }}>
            <table className="w-full border-collapse text-xs">
              <thead className="bg-muted text-muted-foreground sticky top-0">
                <tr>
                  <Th className="w-20 text-center">{t("svnWorkspace.update.table.revision")}</Th>
                  <Th className="w-36">{t("svnWorkspace.update.table.author")}</Th>
                  <Th className="w-44">{t("svnWorkspace.update.table.date")}</Th>
                  <Th>{t("svnWorkspace.update.table.message")}</Th>
                  <Th className="w-24 text-center">
                    {t("svnWorkspace.update.table.changedFiles")}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {incoming.map((entry) => (
                  <tr key={entry.revision} className="border-border/60 border-t">
                    <td className="text-primary px-2 py-1 text-center font-mono">
                      r{entry.revision}
                    </td>
                    <td className="max-w-36 truncate px-2 py-1" title={entry.author}>
                      {entry.author}
                    </td>
                    <td className="text-muted-foreground px-2 py-1">{formatDate(entry.date)}</td>
                    <td className="px-2 py-1">
                      <span className="line-clamp-2 break-words whitespace-pre-wrap">
                        {entry.message}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-center tabular-nums">
                      {entry.changedPaths?.length ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground px-1 py-2 text-xs">
            {checking ? t("svnWorkspace.common.loading") : t("svnWorkspace.update.noIncoming")}
          </p>
        )}
      </section>

      <section className="px-3 pb-3">
        <div className="mb-1.5 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">{t("svnWorkspace.update.localTitle")}</h3>
          <span className="text-muted-foreground text-[11px]">
            {t("svnWorkspace.update.localHint")}
          </span>
        </div>
        {localChanges.length > 0 ? (
          <div className="border-border overflow-auto rounded-md border" style={{ maxHeight: 280 }}>
            <table className="w-full border-collapse text-xs">
              <thead className="bg-muted text-muted-foreground sticky top-0">
                <tr>
                  <Th className="w-24 text-center">{t("svnWorkspace.update.table.status")}</Th>
                  <Th>{t("svnWorkspace.update.table.file")}</Th>
                  <Th className="w-20 text-center">{t("svnWorkspace.update.table.action")}</Th>
                </tr>
              </thead>
              <tbody>
                {localChanges.map((entry) => (
                  <tr key={entry.path} className="border-border/60 border-t">
                    <td className="px-2 py-1 text-center">
                      <StatusBadge code={entry.statusCode} />
                    </td>
                    <td className="px-2 py-1">
                      <button
                        type="button"
                        className="text-primary max-w-full truncate text-left font-mono hover:underline"
                        title={entry.path}
                        onClick={() => openDiff({ path: entry.path })}
                      >
                        {entry.path}
                      </button>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => openDiff({ path: entry.path })}
                      >
                        {t("svnWorkspace.common.diff")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground px-1 py-2 text-xs">
            {t("svnWorkspace.update.noLocalChanges")}
          </p>
        )}
      </section>

      {output ? (
        <div className="border-border bg-muted/30 mx-3 mb-3 rounded-md border">
          <div className="border-border/60 text-muted-foreground border-b px-2 py-1 text-[11px] font-medium">
            {t("svnWorkspace.update.output")}
          </div>
          <pre className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-muted/30 rounded-md border px-3 py-2">
      <div className="text-muted-foreground text-[11px]">{label}</div>
      <div className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn("px-2 py-1.5 text-left font-semibold", className)} scope="col">
      {children}
    </th>
  );
}

export default UpdatePanel;
