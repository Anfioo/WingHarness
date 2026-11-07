// The page's native-session sidebar.
//
// Lists the Claude and Codex sessions the backend discovered, newest first,
// filtered locally and bucketed into today / yesterday / earlier. Clicking a
// row opens it as a tab; clicking a row that is already open focuses it.

import { useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import type { AgentSessionMeta } from "@/commands/services/agent-chat/types";
import { AgentSessionItem } from "@/components/agent-chat/session-item";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentSessions } from "@/hooks/use-agent-sessions";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { resolveDefaultWorkspace, useAgentChatStore } from "@/features/agent-chat/store";

type SessionBucket = "today" | "yesterday" | "earlier";

const BUCKETS: SessionBucket[] = ["today", "yesterday", "earlier"];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function bucketOf(timestamp: number, todayStart: number, yesterdayStart: number): SessionBucket {
  if (timestamp >= todayStart) return "today";
  if (timestamp >= yesterdayStart) return "yesterday";
  return "earlier";
}

function sessionKey(session: AgentSessionMeta): string {
  return `${session.engine}:${session.sessionId}:${session.workspacePath}`;
}

function groupSessions(
  sessions: AgentSessionMeta[],
  query: string
): Record<SessionBucket, AgentSessionMeta[]> {
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? sessions.filter(
        (session) =>
          session.title.toLowerCase().includes(needle) ||
          session.preview.toLowerCase().includes(needle)
      )
    : sessions;

  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = startOfDay(new Date(now.getTime() - 86_400_000));
  const buckets: Record<SessionBucket, AgentSessionMeta[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const session of filtered) {
    const time = session.updatedAt ?? session.fileMtimeMs;
    buckets[bucketOf(time, todayStart, yesterdayStart)].push(session);
  }
  return buckets;
}

export function AgentSessionSidebar() {
  const { t, language } = useAppTranslation();
  const { sessions, loading, error, refresh } = useAgentSessions();
  const tabs = useAgentChatStore((state) => state.tabs);
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const openSession = useAgentChatStore((state) => state.openSession);
  const newTab = useAgentChatStore((state) => state.newTab);
  const [query, setQuery] = useState("");

  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;

  const labels = useMemo(() => {
    const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    return {
      today: t("agentChat.sidebar.today", { defaultValue: format.format(0, "day") }),
      yesterday: t("agentChat.sidebar.yesterday", { defaultValue: format.format(-1, "day") }),
      earlier: t("agentChat.sidebar.earlier", { defaultValue: t("agentChat.history.title") }),
    } satisfies Record<SessionBucket, string>;
  }, [language, t]);

  const groups = useMemo(() => groupSessions(sessions, query), [query, sessions]);

  const visibleCount = groups.today.length + groups.yesterday.length + groups.earlier.length;

  async function handleNewTab() {
    const engine = activeTab?.engine ?? tabs[0]?.engine ?? "claude";
    const workspace = activeTab?.workspacePath || (await resolveDefaultWorkspace());
    newTab(engine, workspace);
  }

  function handleSelect(session: AgentSessionMeta) {
    void openSession(session.engine, session.sessionId, session.workspacePath);
  }

  const selectedKey =
    activeTab?.sessionId != null ? `${activeTab.engine}:${activeTab.sessionId}` : null;

  return (
    <aside className="flex w-[260px] shrink-0 flex-col gap-2 border-r p-3">
      <div className="flex items-center justify-between gap-1">
        <h2 className="truncate text-sm font-medium">{t("agentChat.sidebar.title")}</h2>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            aria-label={t("agentChat.refresh")}
            title={t("agentChat.refresh")}
          >
            <RefreshCw />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void handleNewTab()}
            aria-label={t("agentChat.newChat")}
            title={t("agentChat.newChat")}
          >
            <Plus />
          </Button>
        </div>
      </div>

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("agentChat.search")}
        aria-label={t("agentChat.search")}
        className="h-8"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && sessions.length === 0 ? (
          <div className="flex flex-col gap-2 pt-1">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : error && sessions.length === 0 ? (
          <div className="flex flex-col items-start gap-2 p-2 text-sm">
            <p className="text-muted-foreground">{t("agentChat.error.load")}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              {t("agentChat.sidebar.retry")}
            </Button>
          </div>
        ) : visibleCount === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">{t("agentChat.sidebar.empty")}</p>
        ) : (
          BUCKETS.map((bucket) =>
            groups[bucket].length > 0 ? (
              <section key={bucket} className="mb-2">
                <h3 className="text-muted-foreground px-2 py-1 text-xs font-medium">
                  {labels[bucket]}
                </h3>
                {groups[bucket].map((session) => (
                  <AgentSessionItem
                    key={sessionKey(session)}
                    session={session}
                    selected={selectedKey === `${session.engine}:${session.sessionId}`}
                    onSelect={handleSelect}
                  />
                ))}
              </section>
            ) : null
          )
        )}
      </div>
    </aside>
  );
}
