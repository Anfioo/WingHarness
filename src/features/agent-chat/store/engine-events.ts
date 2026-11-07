// Projection from one `agent:event` entry to a tab's state.
//
// A0 implements the two events the shell needs to settle a turn (`done`,
// `error`). F2 extends this switch to delta/thinking/tool/question/grant; the
// signature stays `(tab, event) => AgentTabState` and must stay pure.

import type { AgentRunEvent } from "@/commands/services/agent-chat/types";
import type { AgentTabState } from "../types";
import { nextSeq } from "./stream";

function errorText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The run failed.";
}

/** Applies one event to a tab, returning the next tab state. */
export function applyRunEvent(tab: AgentTabState, event: AgentRunEvent): AgentTabState {
  switch (event.kind) {
    case "done":
      return { ...tab, status: "idle", runId: null };
    case "error":
      return {
        ...tab,
        status: "error",
        runId: null,
        messages: [
          ...tab.messages,
          { kind: "error", seq: nextSeq(tab.messages), message: errorText(event.data) },
        ],
      };
    default:
      return tab;
  }
}
