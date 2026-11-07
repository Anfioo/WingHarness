// `ui.json` persistence.
//
// Reads through `agent_ui_get` and writes through `agent_ui_set` with a 150 ms
// debounce, so dragging a tab does not produce one disk write per frame. F1
// owns the final scheduling; the exported names are frozen.

import { agentUiGet, agentUiSet } from "@/commands/services/agent-chat";
import type { AgentUiState } from "@/commands/services/agent-chat/types";

const SAVE_DELAY_MS = 150;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: AgentUiState | null = null;

/** Loads the persisted page state; a missing file comes back as defaults. */
export async function loadAgentUiState(): Promise<AgentUiState> {
  return await agentUiGet();
}

/** Queues a save; the last state wins. */
export function scheduleAgentUiSave(state: AgentUiState): void {
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

/** Writes the queued state immediately (used on unmount). */
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
