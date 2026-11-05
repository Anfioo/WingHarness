/**
 * Claude Code's stored conversations, read only.
 *
 * The left rail lists the projects Claude Code has sessions for; picking one
 * loads its transcript on the right, either as nodes — one per message, tool
 * calls folded away — or as the full transcript the chat page shows.
 *
 * Nothing here talks to the model. What it can do is copy: clone a whole
 * session, or fork it at the reply the CLI had been waiting on, which is the
 * node view's "one node becomes two".
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download, GitFork, History, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  listClaudeProjects,
  loadClaudeProjectSession,
  saveTextFile,
  type ClaudeLoadedSession,
  type ClaudeNewSession,
  type ClaudeProjectSummary,
  type ClaudeSessionBranch,
} from "@/commands";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { toTranscriptItems } from "@/lib/use-claude/history-items";
import { TranscriptPane } from "../claude-chat/transcript-pane";
import { exportFileName, sessionMarkdown, type ExportMode } from "./markdown";
import { HistoryNavigator, type HistorySelection } from "./navigator";
import { NewSessionDialog, type CopyRequest } from "./new-session-dialog";
import { NodeFlow } from "./node-flow";
import { toNodes, type ConversationNode } from "./nodes";

type ViewMode = "nodes" | "full";

/**
 * The session a link pointed at. The workflow canvas opens a conversation here
 * with `?project=&session=&title=`, so that clicking a node on the board lands
 * on that conversation in the viewer.
 */
function selectionFromSearch(search: string): HistorySelection | null {
  const params = new URLSearchParams(search);
  const project = params.get("project");
  const sessionId = params.get("session");
  if (!project || !sessionId) return null;
  return { project, sessionId, title: params.get("title") || sessionId };
}

export default function ClaudeHistoryPage() {
  const { t } = useAppTranslation();
  const { search, navigate } = useRouter();
  const [projects, setProjects] = useState<ClaudeProjectSummary[] | null>(null);
  const [root, setRoot] = useState("");
  const [listError, setListError] = useState("");
  const [selection, setSelection] = useState<HistorySelection | null>(() =>
    selectionFromSearch(search)
  );
  const [session, setSession] = useState<ClaudeLoadedSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<ViewMode>("nodes");
  // Bumped after a copy, so the rail and the viewer re-read what changed.
  const [token, setToken] = useState(0);
  const [copy, setCopy] = useState<CopyRequest | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setListError("");
    listClaudeProjects()
      .then((view) => {
        if (cancelled) return;
        setProjects(view.projects);
        setRoot(view.root);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProjects([]);
        setListError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!selection) {
      setSession(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    loadClaudeProjectSession(selection.project, selection.sessionId)
      .then((loaded) => {
        if (!cancelled) setSession(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSession(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection, token]);

  const nodes = useMemo(() => (session ? toNodes(session.records) : []), [session]);
  const items = useMemo(() => (session ? toTranscriptItems(session.records) : []), [session]);
  // Copies of the whole session are not tied to a node, so the header lists them.
  const clones = (session?.branches ?? []).filter((branch) => !branch.forkUuid);

  const openBranch = useCallback((branch: ClaudeSessionBranch) => {
    setSelection({ project: branch.project, sessionId: branch.sessionId, title: branch.title });
  }, []);

  // The workflow page draws one conversation together with everything copied or
  // forked out of it, so a session is handed over by its project and id.
  const openFamily = useCallback(
    (target: HistorySelection) => {
      const params = new URLSearchParams({
        project: target.project,
        session: target.sessionId,
        title: target.title,
      });
      navigate(`/claude-workflow?${params.toString()}`);
    },
    [navigate]
  );

  const handleCreated = useCallback((created: ClaudeNewSession, title: string) => {
    setCopy(null);
    setToken((value) => value + 1);
    setSelection({ project: created.project, sessionId: created.sessionId, title });
  }, []);

  // The dialog comes first: a cancelled save must not build a file nobody asked
  // for, and the picked path is what lets the backend write outside its roots.
  const handleExport = useCallback(
    async (mode: ExportMode) => {
      // A selection change keeps the previous session on screen until the new
      // one loads; exporting then would pair its title with the old records.
      if (!session || !selection || session.sessionId !== selection.sessionId) return;
      const path = await save({
        defaultPath: exportFileName(selection.title, selection.sessionId),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      setExporting(true);
      try {
        await saveTextFile(
          path,
          sessionMarkdown({
            title: selection.title,
            project: selection.project,
            sessionId: selection.sessionId,
            records: session.records,
            mode,
            t,
          })
        );
        toast.success(t("claudeHistory.exportDone"));
      } catch (err: unknown) {
        toast.error(`${t("claudeHistory.exportFailed")}: ${String(err)}`);
      } finally {
        setExporting(false);
      }
    },
    [session, selection, t]
  );

  return (
    <AppShell>
      <section className="flex h-full w-full flex-col gap-4">
        <div className="flex min-h-0 flex-1 gap-4">
          <aside className="border-border bg-card flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border shadow-sm">
            <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <History className="text-muted-foreground size-4" />
              <span className="text-sm font-medium">{t("claudeHistory.projectsTitle")}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2"
                title={t("claudeHistory.refresh")}
                onClick={() => setToken((value) => value + 1)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <HistoryNavigator
                projects={projects}
                root={root}
                loading={projects === null}
                error={listError}
                reloadToken={token}
                selection={selection}
                onSelect={setSelection}
              />
            </div>
          </aside>

          <section className="border-border bg-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border shadow-sm">
            {selection === null ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
                <History className="text-muted-foreground size-10" />
                <p className="text-muted-foreground text-sm">{t("claudeHistory.empty")}</p>
              </div>
            ) : (
              <>
                <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
                  <span className="min-w-0 basis-full sm:basis-auto">
                    <span className="block truncate text-sm font-medium">{selection.title}</span>
                    <span
                      className="text-muted-foreground block truncate font-mono text-[11px]"
                      title={selection.project}
                    >
                      {selection.sessionId}
                    </span>
                  </span>

                  {clones.map((branch) => (
                    <button key={branch.sessionId} type="button" onClick={() => openBranch(branch)}>
                      <Badge variant="secondary" className="gap-1 font-normal">
                        <Copy className="size-3" />
                        {branch.title}
                      </Badge>
                    </button>
                  ))}

                  <div className="ml-auto flex items-center gap-2">
                    <Tabs value={view} onValueChange={(value) => setView(value as ViewMode)}>
                      <TabsList>
                        <TabsTrigger value="nodes">{t("claudeHistory.viewNodes")}</TabsTrigger>
                        <TabsTrigger value="full">{t("claudeHistory.viewFull")}</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <Button
                      variant="outline"
                      size="sm"
                      title={t("claudeHistory.viewFamily")}
                      onClick={() => openFamily(selection)}
                    >
                      <GitFork className="size-4" />
                      {t("claudeHistory.viewFamily")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={session === null}
                      onClick={() =>
                        setCopy({
                          kind: "clone",
                          defaultTitle: `${selection.title} ${t("claudeHistory.copySuffix")}`,
                        })
                      }
                    >
                      <Copy className="size-4" />
                      {t("claudeHistory.clone")}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            session === null ||
                            session.sessionId !== selection.sessionId ||
                            exporting
                          }
                        >
                          <Download className="size-4" />
                          {t("claudeHistory.export")}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => void handleExport("conversation")}>
                          {t("claudeHistory.exportConversation")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handleExport("tools")}>
                          {t("claudeHistory.exportWithTools")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void handleExport("full")}>
                          {t("claudeHistory.exportFull")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {error ? (
                  <p className="text-destructive p-4 text-sm">{error}</p>
                ) : loading || session === null ? (
                  <div className="flex flex-col gap-3 p-4">
                    {[0, 1, 2].map((row) => (
                      <Skeleton key={row} className="h-20 w-full rounded-xl" />
                    ))}
                  </div>
                ) : session.records.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-sm">
                    {t("claudeHistory.sessionEmpty")}
                  </p>
                ) : view === "nodes" ? (
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <NodeFlow
                      nodes={nodes}
                      branches={session.branches}
                      onFork={(node: ConversationNode) =>
                        setCopy({
                          kind: "fork",
                          forkUuid: node.uuid,
                          defaultTitle: `${selection.title} ${t("claudeHistory.branchSuffix")}`,
                        })
                      }
                      onOpenBranch={openBranch}
                    />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col p-4">
                    <TranscriptPane items={items} />
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </section>

      {copy && selection && (
        <NewSessionDialog
          key={`${copy.kind}-${copy.forkUuid ?? "all"}`}
          request={copy}
          project={selection.project}
          sessionId={selection.sessionId}
          onClose={() => setCopy(null)}
          onCreated={handleCreated}
        />
      )}
    </AppShell>
  );
}
