/**
 * The left rail: the projects that have a conversation family, each expanding to
 * the families themselves.
 *
 * A family is named after the conversation everything was copied from, so this
 * is the list of the conversations a picture can be opened for — a fork or a
 * clone is never an entry of its own, it is part of the family it came out of.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, FolderGit2, GitFork } from "lucide-react";
import type { ClaudeFamilySummary } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { formatHistoryTime } from "../claude-chat/format";

export interface FamilySelection {
  project: string;
  sessionId: string;
  title: string;
}

export function FamilyRail({
  families,
  store,
  loading,
  error,
  selection,
  onSelect,
}: {
  families: ClaudeFamilySummary[] | null;
  store: string;
  loading: boolean;
  error: string;
  selection: FamilySelection | null;
  onSelect: (selection: FamilySelection) => void;
}) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);

  // The page can be opened on a family — the history page links to one — so its
  // project opens rather than staying shut over the picture being shown.
  useEffect(() => {
    if (selection) setExpanded(selection.project);
  }, [selection]);

  const groups = useMemo(() => {
    const byProject = new Map<string, ClaudeFamilySummary[]>();
    for (const family of families ?? []) {
      const list = byProject.get(family.rootProject);
      if (list) list.push(family);
      else byProject.set(family.rootProject, [family]);
    }
    return [...byProject.entries()];
  }, [families]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (families === null || families.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-sm">
        {error || t("claudeWorkflow.familiesEmpty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="text-muted-foreground truncate px-2 py-1 font-mono text-xs" title={store}>
        {store}
      </p>
      {groups.map(([project, rows]) => {
        const open = expanded === project;
        return (
          <div key={project}>
            <button
              type="button"
              onClick={() => setExpanded(open ? null : project)}
              title={project}
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
                <span className="block truncate text-sm">{projectName(project)}</span>
                <span className="text-muted-foreground block truncate font-mono text-[11px]">
                  {project}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">{rows.length}</span>
            </button>

            {open && (
              <div className="border-border mt-1 ml-4 flex flex-col gap-1 border-l pl-2">
                {rows.map((family) => (
                  <button
                    key={family.rootSessionId}
                    type="button"
                    title={family.rootSessionId}
                    onClick={() =>
                      onSelect({
                        project: family.rootProject,
                        sessionId: family.rootSessionId,
                        title: family.title,
                      })
                    }
                    className={cn(
                      "hover:bg-accent flex flex-col gap-1 rounded-lg px-2 py-1.5 text-left transition-colors",
                      selection?.sessionId === family.rootSessionId &&
                        selection.project === family.rootProject &&
                        "bg-accent"
                    )}
                  >
                    <span className="line-clamp-2 text-sm">{family.title}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted-foreground font-mono text-[11px]">
                        {formatHistoryTime(family.lastMs || family.modifiedMs)}
                      </span>
                      {family.forks > 0 && (
                        <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                          <GitFork className="size-2.5" />
                          {family.forks}
                        </Badge>
                      )}
                      {family.clones > 0 && (
                        <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                          <Copy className="size-2.5" />
                          {family.clones}
                        </Badge>
                      )}
                    </span>
                  </button>
                ))}
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
