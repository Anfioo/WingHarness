// `ui.json` persistence.
//
// Reads through `agent_ui_get` and writes through `agent_ui_set` with a 150 ms
// debounce, so dragging a tab does not produce one disk write per frame.

import { agentUiGet, agentUiSet } from "@/commands";
import type { AgentTab, AgentUiState } from "@/commands/services/agent-chat/types";

const SAVE_DELAY_MS = 150;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: AgentUiState | null = null;

/** The state a first launch (or a corrupt `ui.json`) starts from. */
export function defaultUiState(): AgentUiState {
  return {
    version: 1,
    openTabs: [],
    activeTabId: null,
    lastEngine: "claude",
    engines: {},
    grants: {},
    recentWorkspaces: [],
  };
}

/** Loads the persisted page state; rejects when the command fails. */
export async function loadUiState(): Promise<AgentUiState> {
  return await agentUiGet();
}

/** Queues a save; the last state wins. */
export function saveUiState(state: AgentUiState): void {
  pending = state;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const snapshot = pending;
    pending = null;
    if (!snapshot) return;
    void agentUiSet(snapshot).catch((error: unknown) => {
      console.warn("agent-chat: failed to persist ui.json", error);
    });
  }, SAVE_DELAY_MS);
}

/** Writes the queued state immediately (used on unload). */
export function flushAgentUiSave(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const snapshot = pending;
  pending = null;
  if (!snapshot) return;
  void agentUiSet(snapshot).catch((error: unknown) => {
    console.warn("agent-chat: failed to persist ui.json", error);
  });
}

/** The stable UI key of a tab: the locally generated id, not the session id. */
export function tabKeyOf(tab: AgentTab): string {
  return tab.tabId;
}

// A0 aliases kept for the code that was handed over with the stub.
export const loadAgentUiState = loadUiState;
export const scheduleAgentUiSave = saveUiState;
