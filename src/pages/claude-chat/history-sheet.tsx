/**
 * The history drawer: Claude Code's own stored sessions for this working
 * directory, newest first. Picking one loads its transcript so the conversation
 * can be continued — the id travels with it, which is what makes the next
 * message a `--resume` of that session rather than a new one.
 *
 * The list is read from disk only when the drawer opens: nothing here is worth
 * paying for on every chat page mount.
 */

import { useCallback, useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { listClaudeSessions, loadClaudeSession, type ClaudeSessionSummary } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { toTranscriptItems } from "@/lib/use-claude/history-items";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { cn } from "@/lib/utils";
import { formatHistoryTime } from "./format";

/** A session restored from disk, ready to seed a fresh chat session with. */
export interface RestoredSession {
  sessionId: string;
  items: TranscriptItem[];
}

export function HistorySheet({
  cwd,
  disabled,
  onRestore,
}: {
  cwd: string;
  disabled: boolean;
  onRestore: (session: RestoredSession) => void;
}) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ClaudeSessionSummary[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    listClaudeSessions(cwd)
      .then((view) => {
        if (cancelled) return;
        setSessions(view.sessions);
        setDir(view.dir);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  const handleOpen = useCallback(
    async (session: ClaudeSessionSummary) => {
      setOpeningId(session.id);
      setError("");
      try {
        const loaded = await loadClaudeSession(cwd, session.id);
        onRestore({ sessionId: loaded.sessionId, items: toTranscriptItems(loaded.records) });
        setOpen(false);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setOpeningId(null);
      }
    },
    [cwd, onRestore]
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <History className="size-4" />
          {t("claudeChat.history")}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-2 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("claudeChat.history")}</SheetTitle>
          <SheetDescription className="truncate font-mono text-xs" title={dir}>
            {dir}
          </SheetDescription>
        </SheetHeader>

        {error && (
          <p className="text-destructive px-4 pb-2 text-xs">{t("claudeChat.historyError")}</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs">{t("claudeChat.historyLoading")}</p>
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("claudeChat.historyEmpty")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  title={session.preview || session.title}
                  disabled={openingId !== null}
                  onClick={() => void handleOpen(session)}
                  className={cn(
                    "border-border hover:bg-accent flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                    "disabled:pointer-events-none disabled:opacity-60"
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="line-clamp-2 text-sm font-medium">{session.title}</span>
                    {openingId === session.id && (
                      <Loader2 className="text-muted-foreground mt-0.5 size-4 shrink-0 animate-spin" />
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatHistoryTime(session.modifiedMs)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
