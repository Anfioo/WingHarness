// The `agent:event` subscription.
//
// One listener for the whole page: each batch is folded into the owning tab by
// `runId`, then committed with a single store write so a burst of events costs
// one render. F1/F2 keep this shape and only grow `applyRunEvent`.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AgentRunEvent } from "@/commands/services/agent-chat/types";
import { useAgentChatStore } from "./store";
import { applyRunEvent } from "./store/engine-events";

/** Event name emitted by `agent-chat-core::engine::sink`. */
export const AGENT_EVENT_NAME = "agent:event";

/** Subscribes to the batched run events; returns the unlisten handle. */
export async function startAgentEventStream(): Promise<UnlistenFn> {
  return await listen<AgentRunEvent[]>(AGENT_EVENT_NAME, (event) => {
    const batch = event.payload;
    if (!Array.isArray(batch) || batch.length === 0) return;

    const state = useAgentChatStore.getState();
    const runToTab = new Map<string, string>();
    for (const tab of state.tabs) {
      const runId = state.byTab[tab.tabId]?.runId;
      if (runId) runToTab.set(runId, tab.tabId);
    }

    const byTab = { ...state.byTab };
    let changed = false;
    for (const item of batch) {
      const tabId = runToTab.get(item.runId);
      if (!tabId) continue;
      const current = byTab[tabId];
      if (!current) continue;
      byTab[tabId] = applyRunEvent(current, item);
      changed = true;
    }

    if (changed) useAgentChatStore.setState({ byTab });
  });
}
