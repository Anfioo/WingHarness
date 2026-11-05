/**
 * The left rail: every project Claude Code has stored sessions for, each
 * expanding to its sessions.
 *
 * A project's sessions are read only when it is expanded, so opening the page
 * costs one directory scan rather than one per project. Sessions this app copied
 * carry a badge saying what they were copied from.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FolderGit2, Loader2 } from "lucide-react";
import {
  listClaudeProjectSessions,
  type ClaudeProjectSummary,
  type ClaudeSessionSummary,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { formatHistoryTime } from "../claude-chat/format";

export interface HistorySelection {
  project: string;
  sessionId: string;
  title: string;
}

export function HistoryNavigator({
  projects,
  root,
  selection,
  loading,
  error,
  /** Bumped after a copy, to re-read the session lists. */
  reloadToken,
  onSelect,
}: {
  projects: ClaudeProjectSummary[] | null;
  root: string;
  selection: HistorySelection | null;
  loading: boolean;
  error: string;
  reloadToken: number;
  onSelect: (selection: HistorySelection) => void;
}) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, ClaudeSessionSummary[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Which project is open, readable from the reload effect without making it a
  // dependency — re-reading after a copy must not close the open project.
  const expandedRef = useRef<string | null>(null);

  const load = useCallback((project: string) => {
    setBusy(project);
    listClaudeProjectSessions(project)
      .then((view) => setSessions((current) => ({ ...current, [project]: view.sessions })))
      .catch(() => setSessions((current) => ({ ...current, [project]: [] })))
      .finally(() => setBusy(null));
  }, []);

  // A copy changes what a project holds, so the lists read earlier are stale.
  useEffect(() => {
    setSessions({});
    const project = expandedRef.current;
    if (project) load(project);
  }, [reloadToken, load]);

  // A session can be selected from outside — the workflow canvas links to one —
  // so the rail opens the project holding it instead of leaving it collapsed.
  useEffect(() => {
    if (!selection || expandedRef.current === selection.project) return;
    expandedRef.current = selection.project;
    setExpanded(selection.project);
    if (!sessions[selection.project]) load(selection.project);
  }, [selection, sessions, load]);

  const toggle = useCallback(
    (project: string) => {
      const next = expandedRef.current === project ? null : project;
      expandedRef.current = next;
      setExpanded(next);
      if (next && !sessions[project]) load(project);
    },
    [load, sessions]
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (projects === null || projects.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-sm">
        {error || t("claudeHistory.projectsEmpty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="text-muted-foreground truncate px-2 py-1 font-mono text-xs" title={root}>
        {root}
      </p>
      {projects.map((project) => {
        const open = expanded === project.slug;
        const rows = sessions[project.slug];
        return (
          <div key={project.slug}>
            <button
              type="button"
              onClick={() => toggle(project.slug)}
              title={project.path}
              className={cn(
                "hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                open && "bg-accent/60"
              )}
            >
              {open ? (
                <ChevronDown className="text-muted-foreground size-4 shrink-0" />
              ) : (
                <ChevronRight className="text-muted-foreground size-4 shrink-0" />
              )}
              <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{projectName(project.path)}</span>
                <span className="text-muted-foreground block truncate font-mono text-[11px]">
                  {project.path}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">{project.sessionCount}</span>
            </button>

            {open && (
              <div className="border-border mt-1 ml-4 flex flex-col gap-1 border-l pl-2">
                {busy === project.slug || !rows ? (
                  <span className="text-muted-foreground inline-flex items-center gap-2 px-2 py-1.5 text-xs">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("claudeHistory.sessionsLoading")}
                  </span>
                ) : rows.length === 0 ? (
                  <span className="text-muted-foreground px-2 py-1.5 text-xs">
                    {t("claudeHistory.sessionsEmpty")}
                  </span>
                ) : (
                  rows.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      title={session.preview || session.title}
                      onClick={() =>
                        onSelect({
                          project: project.slug,
                          sessionId: session.id,
                          title: session.title,
                        })
                      }
                      className={cn(
                        "hover:bg-accent flex flex-col gap-1 rounded-lg px-2 py-1.5 text-left transition-colors",
                        selection?.sessionId === session.id &&
                          selection.project === project.slug &&
                          "bg-accent"
                      )}
                    >
                      <span className="line-clamp-2 text-sm">{session.title}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {formatHistoryTime(session.modifiedMs)}
                        </span>
                        {session.origin && (
                          <Badge
                            variant="secondary"
                            className="px-1.5 py-0 text-[10px] font-normal"
                            title={t(`claudeHistory.origin_${session.origin.kind}`)}
                          >
                            {t(`claudeHistory.origin_${session.origin.kind}`)}
                          </Badge>
                        )}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The last segment of a working directory, which is what names the project. */
function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
