/**
 * The workflow view: one conversation family at a time, drawn as a tree.
 *
 * The rail on the left lists the projects with a family and, under each, the
 * families themselves — the conversation everything was copied from. Picking one
 * draws it: the trunk in full, a fork merged into the trunk up to the message it
 * branches from and then leaving with what it has of its own, and a clone as a
 * line beside the conversation it was copied from.
 *
 * Nothing here talks to the model, and nothing is stored: the relationships come
 * from the app's own data directory, the turns from the session files, and every
 * conversation on the board opens in the history viewer, where the messages are.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, GitFork, History, RefreshCw, Users, X } from "lucide-react";
import {
  listClaudeFamilies,
  loadClaudeFamily,
  type ClaudeFamilyGraph,
  type ClaudeFamilySummary,
  type ClaudeWorkflowSession,
} from "@/commands";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { formatHistoryTime } from "../claude-chat/format";
import { WorkflowCanvas } from "./canvas";
import { buildWorkflow } from "./graph";
import { FamilyRail, type FamilySelection } from "./rail";

/** How many conversations one list in the panel shows before it says how many
 *  more there are. */
const PANEL_LIST_MAX = 4;

/**
 * The family a link pointed at. The history page opens a conversation here with
 * `?project=&session=&title=`, so that opening a family to see its forks does
 * not have to go through the rail.
 */
function selectionFromSearch(search: string): FamilySelection | null {
  const params = new URLSearchParams(search);
  const project = params.get("project");
  const sessionId = params.get("session");
  if (!project || !sessionId) return null;
  return { project, sessionId, title: params.get("title") || sessionId };
}

export default function ClaudeWorkflowPage() {
  const { t } = useAppTranslation();
  const { search, navigate } = useRouter();
  const [families, setFamilies] = useState<ClaudeFamilySummary[] | null>(null);
  const [store, setStore] = useState("");
  const [listError, setListError] = useState("");
  const [selection, setSelection] = useState<FamilySelection | null>(() =>
    selectionFromSearch(search)
  );
  const [graph, setGraph] = useState<ClaudeFamilyGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped after a copy or a refresh, so the lists and the board re-read.
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setListError("");
    listClaudeFamilies()
      .then((view) => {
        if (cancelled) return;
        setFamilies(view.families);
        setStore(view.store);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFamilies([]);
        setListError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!selection) {
      setGraph(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setSelectedId(null);
    loadClaudeFamily(selection.project, selection.sessionId)
      .then((loaded) => {
        if (!cancelled) setGraph(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setGraph(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection, token]);

  const layout = useMemo(() => (graph ? buildWorkflow(graph) : null), [graph]);
  const selected = useMemo(
    () => layout?.nodes.find((node) => node.id === selectedId) ?? null,
    [layout, selectedId]
  );

  const openSession = useCallback(
    (session: ClaudeWorkflowSession) => {
      const params = new URLSearchParams({
        project: session.project,
        session: session.sessionId,
        title: session.title,
      });
      navigate(`/claude-history?${params.toString()}`);
    },
    [navigate]
  );

  return (
    <AppShell>
      <section className="flex h-full w-full flex-col gap-4">
        <div className="flex min-h-0 flex-1 gap-4">
          <aside className="border-border bg-card flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border shadow-sm">
            <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <GitFork className="text-muted-foreground size-4" />
              <span className="text-sm font-medium">{t("claudeWorkflow.familiesTitle")}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2"
                title={t("claudeWorkflow.refresh")}
                onClick={() => setToken((value) => value + 1)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <FamilyRail
                families={families}
                store={store}
                loading={families === null}
                error={listError}
                selection={selection}
                onSelect={setSelection}
              />
            </div>
          </aside>

          <section className="border-border bg-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border shadow-sm">
            {selection === null ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <GitFork className="text-muted-foreground size-10" />
                <p className="text-sm font-medium">{t("claudeWorkflow.pickFamily")}</p>
                <p className="text-muted-foreground max-w-md text-xs">
                  {t("claudeWorkflow.emptyHint")}
                </p>
              </div>
            ) : (
              <>
                <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
                  <History className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 basis-full sm:basis-auto">
                    <span className="block truncate text-sm font-medium">
                      {graph?.sessions[0]?.title ?? selection.title}
                    </span>
                    <span
                      className="text-muted-foreground block truncate font-mono text-[11px]"
                      title={selection.project}
                    >
                      {graph?.rootSessionId ?? selection.sessionId}
                    </span>
                  </span>
                  {graph && graph.sessions.length > 0 && (
                    <>
                      <Badge variant="secondary" className="gap-1 font-normal">
                        <Users className="size-3" />
                        {t("claudeWorkflow.sessions", { count: graph.sessions.length })}
                      </Badge>
                      <Badge variant="secondary" className="gap-1 font-normal">
                        <Copy className="size-3" />
                        {t("claudeWorkflow.copies", {
                          count: graph.sessions.length - 1,
                        })}
                      </Badge>
                    </>
                  )}
                  {graph && (
                    <span
                      className="text-muted-foreground ml-auto hidden truncate font-mono text-[11px] lg:block"
                      title={t("claudeWorkflow.store", { path: graph.store })}
                    >
                      {graph.store}
                    </span>
                  )}
                </div>

                {error ? (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
                    <p className="text-destructive text-sm">{error}</p>
                    <p className="text-muted-foreground text-xs">
                      {t("claudeWorkflow.loadFailed")}
                    </p>
                  </div>
                ) : loading || graph === null ? (
                  <div className="flex min-h-0 flex-1 items-stretch p-4">
                    <Skeleton className="h-full w-full rounded-xl" />
                  </div>
                ) : layout ? (
                  <WorkflowCanvas
                    layout={layout}
                    selectedId={selectedId}
                    onSelect={(node) => setSelectedId(node?.id ?? null)}
                    onOpenSession={(node) => openSession(node.owner)}
                  />
                ) : null}
              </>
            )}
          </section>

          {selected && (
            <aside className="border-border bg-card flex w-80 shrink-0 flex-col overflow-hidden rounded-xl border shadow-sm">
              <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
                <span className="text-sm font-medium">{t("claudeWorkflow.detailTitle")}</span>
                {selected.timestamp && (
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {formatHistoryTime(Date.parse(selected.timestamp))}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7"
                  title={t("claudeWorkflow.closeDetail")}
                  onClick={() => setSelectedId(null)}
                >
                  <X className="size-3.5" />
                </Button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                <div>
                  <p className="text-muted-foreground mb-1 text-[11px] font-medium">
                    {t("claudeWorkflow.you")}
                  </p>
                  <p className="text-xs leading-relaxed whitespace-pre-wrap">
                    {selected.empty
                      ? t("claudeWorkflow.emptyFork")
                      : selected.question || t("claudeWorkflow.noQuestion")}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1 text-[11px] font-medium">
                    {t("claudeWorkflow.claude")}
                  </p>
                  <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                    {selected.empty
                      ? t("claudeWorkflow.emptyForkHint")
                      : selected.answer || t("claudeWorkflow.noReply")}
                  </p>
                </div>

                <SessionList
                  label={t("claudeWorkflow.inSessions", {
                    count: selected.sessions.length,
                  })}
                  sessions={selected.sessions}
                  onOpen={openSession}
                />

                {selected.branchOf.length > 0 && (
                  <SessionList
                    label={t("claudeWorkflow.continuedBy")}
                    sessions={selected.branchOf}
                    onOpen={openSession}
                  />
                )}

                {selected.branches.length > 0 && (
                  <SessionList
                    label={t("claudeWorkflow.branchedHere")}
                    sessions={selected.branches}
                    onOpen={openSession}
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
    </AppShell>
  );
}

/** The conversations a turn appears in, or the ones forked off it, each opening
 *  in the history viewer — where the messages themselves are read. */
function SessionList({
  label,
  sessions,
  onOpen,
}: {
  label: string;
  sessions: ClaudeWorkflowSession[];
  onOpen: (session: ClaudeWorkflowSession) => void;
}) {
  const { t } = useAppTranslation();
  const shown = sessions.slice(0, PANEL_LIST_MAX);
  return (
    <div>
      <p className="text-muted-foreground mb-1 text-[11px] font-medium">{label}</p>
      <div className="flex flex-col gap-1">
        {shown.map((session) => (
          <button
            key={`${session.project}-${session.sessionId}`}
            type="button"
            onClick={() => onOpen(session)}
            title={session.sessionId}
            className="border-border hover:bg-accent flex items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-[11px] transition-colors"
          >
            <History className="text-muted-foreground size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            {session.forkUuid && <GitFork className="text-muted-foreground size-3 shrink-0" />}
          </button>
        ))}
        {sessions.length > shown.length && (
          <span className="text-muted-foreground px-1 text-[11px]">
            {t("claudeWorkflow.andMore", { count: sessions.length - shown.length })}
          </span>
        )}
      </div>
    </div>
  );
}
