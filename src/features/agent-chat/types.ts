// The Agent chat page's view types.
//
// Mirrors the DTOs in `@/commands/services/agent-chat/types` but adds the row
// union the timeline renders and the tab-local state the store keeps. Frozen
// after A0: the UI lanes fill behavior, not shapes.

import type { AgentChatErrorCode } from "@/commands/services/agent-chat/types";

/** A rejected command, shaped for inline presentation. */
export type AgentChatErrorView = {
  code: AgentChatErrorCode;
  message: string;
  detail: string | null;
};

/** One question of a question card. */
export type AgentQuestion = {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

/** One row of the timeline. */
export type AgentMessageRow =
  | { kind: "user"; seq: number; text: string; ts: string | null }
  | { kind: "assistant"; seq: number; text: string; ts: string | null; live: boolean }
  | { kind: "thinking"; seq: number; text: string; live: boolean; collapsed: boolean }
  | {
      kind: "tool";
      seq: number;
      toolName: string;
      toolCallId: string | null;
      path: string | null;
      args: unknown;
      result: unknown;
      status: "running" | "done" | "error" | "stopped";
      startedAt: number;
    }
  | {
      kind: "question";
      seq: number;
      requestId: string;
      toolUseId: string | null;
      questions: AgentQuestion[];
      status: "pending" | "answered" | "dismissed";
    }
  | {
      kind: "grant";
      seq: number;
      tool: string | null;
      path: string | null;
      message: string;
      toolUseId: string | null;
      status: "pending" | "granted" | "dismissed";
    }
  | { kind: "error"; seq: number; message: string };

/** Everything one tab remembers while the page is mounted. */
export interface AgentTabState {
  runId: string | null;
  status: "idle" | "launching" | "streaming" | "error";
  messages: AgentMessageRow[];
  nextBefore: number | null;
  loading: boolean;
  error: AgentChatErrorView | null;
  retry: { attempt: number; max: number; message: string } | null;
  compacting: boolean;
  usage: unknown;
  activeModel: string | null;
  activeEffort: string | null;
}

/** The shape a fresh tab starts from. */
export function initialTabState(): AgentTabState {
  return {
    runId: null,
    status: "idle",
    messages: [],
    nextBefore: null,
    loading: false,
    error: null,
    retry: null,
    compacting: false,
    usage: null,
    activeModel: null,
    activeEffort: null,
  };
}
