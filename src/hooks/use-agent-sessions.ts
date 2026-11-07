// The sidebar's session list.
//
// Reads the page store and refreshes it once on mount. The payload is the same
// `agent_list_sessions(null, null, 200)` the store bootstraps with; keeping the
// refresh here means remounting the sidebar (or pressing Retry) does not reload
// the engines.

import { useCallback, useEffect } from "react";

import type { AgentSessionMeta } from "@/commands/services/agent-chat/types";
import type { AgentChatErrorView } from "@/features/agent-chat/types";
import { useAgentChatStore } from "@/features/agent-chat/store";

export interface AgentSessionsState {
  sessions: AgentSessionMeta[];
  loading: boolean;
  error: AgentChatErrorView | null;
  refresh(): Promise<void>;
}

export function useAgentSessions(): AgentSessionsState {
  const sessions = useAgentChatStore((state) => state.sessions);
  const loading = useAgentChatStore((state) => state.sessionsLoading);
  const error = useAgentChatStore((state) => state.uiError);
  const refreshSessions = useAgentChatStore((state) => state.refreshSessions);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const refresh = useCallback(async () => {
    await refreshSessions();
  }, [refreshSessions]);

  return { sessions, loading, error, refresh };
}
