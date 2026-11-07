// Projection from one `agent:event` entry to a tab's state.
//
// The fold is pure: it reads nothing but its arguments. `AgentTabState` has no
// sequence field, so the ordering guard below keys off the previous state
// object and drops replayed or out-of-order events per run.

import type { AgentRunEvent } from "@/commands/services/agent-chat/types";
import type { AgentMessageRow, AgentQuestion, AgentTabState } from "../types";
import {
  appendDelta,
  appendThinking,
  appendUser,
  nextSeq,
  settleLiveRows,
  upsertToolRow,
} from "./stream";

type ToolStatus = Extract<AgentMessageRow, { kind: "tool" }>["status"];

const ordering = new WeakMap<AgentTabState, { runId: string; seq: number }>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The run failed.";
}

function timestamp(event: AgentRunEvent): string | null {
  return event.ts > 0 ? new Date(event.ts).toISOString() : null;
}

function stopRunningTools(rows: AgentMessageRow[]): AgentMessageRow[] {
  return rows.map((row) =>
    row.kind === "tool" && row.status === "running" ? { ...row, status: "stopped" } : row
  );
}

function finishTurn(tab: AgentTabState, status: "idle" | "error"): AgentTabState {
  return {
    ...tab,
    status,
    runId: null,
    retry: null,
    compacting: false,
    messages: stopRunningTools(settleLiveRows(tab.messages)),
  };
}

/** Codex patches a tool result by name, so fall back to the newest open row. */
function newestOpenTool(rows: AgentMessageRow[], toolName: string): AgentMessageRow | null {
  const wanted = toolName.trim().toLowerCase();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind !== "tool") continue;
    if (row.toolName.trim().toLowerCase() !== wanted) continue;
    if (row.result != null) continue;
    return row;
  }
  return null;
}

function resultLooksFailed(value: unknown): boolean {
  if (typeof value === "string") return false;
  const record = asRecord(value);
  if (!record) return false;
  if (record.is_error === true || record.isError === true) return true;
  if (record.success === false) return true;
  const exitCode = readNumber(record.exitCode ?? record.exit_code);
  return exitCode !== null && exitCode !== 0;
}

function applyAssistantMessage(
  tab: AgentTabState,
  text: string,
  event: AgentRunEvent
): AgentTabState {
  const last = tab.messages[tab.messages.length - 1];
  if (last && last.kind === "assistant" && last.live && last.text.trim() === text.trim()) {
    return { ...tab, status: "streaming", retry: null, messages: settleLiveRows(tab.messages) };
  }
  const messages = settleLiveRows(tab.messages);
  return {
    ...tab,
    status: "streaming",
    retry: null,
    messages: [
      ...messages,
      { kind: "assistant", seq: nextSeq(messages), text, ts: timestamp(event), live: false },
    ],
  };
}

function applyToolMessage(
  tab: AgentTabState,
  data: Record<string, unknown>,
  event: AgentRunEvent
): AgentTabState {
  const toolName = readString(data.text)?.trim() || "tool";
  const toolCallId = readString(data.toolCallId)?.trim() || null;
  const patch = data.patch === true;
  const hasResult = Object.prototype.hasOwnProperty.call(data, "result");

  let targetSeq: number | undefined;
  if (!toolCallId) {
    const open = newestOpenTool(tab.messages, toolName);
    // A fresh call without an id owns its own row; only a patch merges.
    if (patch && open) targetSeq = open.seq;
  }

  const status: ToolStatus = hasResult
    ? resultLooksFailed(data.result)
      ? "error"
      : "done"
    : "running";

  const messages = upsertToolRow(tab.messages, {
    seq: targetSeq,
    toolName,
    toolCallId: toolCallId ?? undefined,
    path: readString(data.path) ?? undefined,
    args: data.args,
    result: hasResult ? data.result : undefined,
    status,
    startedAt: event.ts > 0 ? event.ts : undefined,
  });
  return { ...tab, retry: null, messages };
}

function parseQuestions(input: unknown): AgentQuestion[] {
  const payload = asRecord(input);
  const list = payload && Array.isArray(payload.questions) ? payload.questions : [];
  const questions: AgentQuestion[] = [];

  list.forEach((entry, index) => {
    const item = asRecord(entry);
    if (!item) return;
    const question = readString(item.question)?.trim();
    if (!question) return;

    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          const parsed = asRecord(option);
          if (!parsed) return [];
          const label = readString(parsed.label)?.trim();
          if (!label) return [];
          return [{ label, description: readString(parsed.description)?.trim() ?? "" }];
        })
      : [];

    questions.push({
      id: readString(item.id)?.trim() || `q-${index}`,
      header: readString(item.header)?.trim() ?? "",
      question,
      multiSelect: item.multiSelect === true || item.multi_select === true,
      options,
    });
  });

  return questions;
}

function applyQuestion(tab: AgentTabState, data: Record<string, unknown>): AgentTabState {
  const requestId = readString(data.requestId)?.trim();
  if (!requestId) return tab;
  const questions = parseQuestions(data.input);
  if (questions.length === 0) return tab;
  if (tab.messages.some((row) => row.kind === "question" && row.requestId === requestId)) {
    return tab;
  }

  const messages = settleLiveRows(tab.messages);
  return {
    ...tab,
    messages: [
      ...messages,
      {
        kind: "question",
        seq: nextSeq(messages),
        requestId,
        toolUseId: readString(data.toolUseId),
        questions,
        status: "pending",
      },
    ],
  };
}

function applyPermissionDenied(tab: AgentTabState, data: Record<string, unknown>): AgentTabState {
  const toolUseId = readString(data.toolUseId);
  if (
    toolUseId &&
    tab.messages.some(
      (row) => row.kind === "grant" && row.toolUseId === toolUseId && row.status === "pending"
    )
  ) {
    return tab;
  }

  const messages = settleLiveRows(tab.messages);
  return {
    ...tab,
    messages: [
      ...messages,
      {
        kind: "grant",
        seq: nextSeq(messages),
        tool: readString(data.tool),
        path: readString(data.path),
        message: readString(data.message)?.trim() ?? "",
        toolUseId,
        status: "pending",
      },
    ],
  };
}

function applyQuestionSettled(tab: AgentTabState, data: Record<string, unknown>): AgentTabState {
  const requestId = readString(data.requestId)?.trim();
  if (!requestId) return tab;

  let changed = false;
  const messages = tab.messages.map((row) => {
    if (row.kind !== "question" || row.requestId !== requestId || row.status !== "pending") {
      return row;
    }
    changed = true;
    return { ...row, status: "dismissed" as const };
  });
  return changed ? { ...tab, messages } : tab;
}

function reduce(tab: AgentTabState, event: AgentRunEvent): AgentTabState {
  switch (event.kind) {
    case "delta": {
      const text = readString(event.data);
      if (!text) return tab;
      return {
        ...tab,
        status: "streaming",
        retry: null,
        messages: appendDelta(tab.messages, text, timestamp(event)),
      };
    }
    case "thinking": {
      const text = readString(event.data);
      if (!text) return tab;
      return {
        ...tab,
        status: "streaming",
        retry: null,
        messages: appendThinking(tab.messages, text, timestamp(event)),
      };
    }
    case "message": {
      const data = asRecord(event.data);
      if (!data) return tab;
      const role = readString(data.role);
      const text = readString(data.text) ?? "";
      if (role === "assistant") {
        return text.trim() ? applyAssistantMessage(tab, text, event) : tab;
      }
      if (role === "tool") return applyToolMessage(tab, data, event);
      if (role === "user") {
        return text.trim()
          ? { ...tab, messages: appendUser(tab.messages, text, timestamp(event)) }
          : tab;
      }
      return tab;
    }
    case "session":
      // The tab's `sessionId` belongs to the store layer, not this fold.
      return tab;
    case "usage":
      return { ...tab, usage: event.data };
    case "model": {
      const model = readString(event.data)?.trim();
      return model ? { ...tab, activeModel: model } : tab;
    }
    case "effort": {
      const effort = readString(event.data)?.trim();
      return effort ? { ...tab, activeEffort: effort } : tab;
    }
    case "retry": {
      const data = asRecord(event.data);
      const attempt = readNumber(data?.attempt);
      const max = readNumber(data?.max);
      if (attempt === null || max === null) return tab;
      return { ...tab, retry: { attempt, max, message: readString(data?.message) ?? "" } };
    }
    case "compaction": {
      const data = asRecord(event.data);
      if (!data) return tab;
      return { ...tab, compacting: data.active === true };
    }
    case "permission_denied": {
      const data = asRecord(event.data);
      return data ? applyPermissionDenied(tab, data) : tab;
    }
    case "question": {
      const data = asRecord(event.data);
      return data ? applyQuestion(tab, data) : tab;
    }
    case "question_settled": {
      const data = asRecord(event.data);
      return data ? applyQuestionSettled(tab, data) : tab;
    }
    case "error": {
      const next = finishTurn(tab, "error");
      return {
        ...next,
        messages: [
          ...next.messages,
          { kind: "error", seq: nextSeq(next.messages), message: errorText(event.data) },
        ],
      };
    }
    case "done": {
      const data = asRecord(event.data);
      const usage = data?.usage;
      const next = { ...finishTurn(tab, "idle"), error: null };
      return usage == null ? next : { ...next, usage };
    }
    case "turn_resumed":
      return { ...tab, status: "streaming", retry: null };
    case "warn":
    default:
      console.debug("agent-chat: ignoring event", event.kind);
      return tab;
  }
}

/** Applies one event to a tab, returning the next tab state. */
export function applyRunEvent(tab: AgentTabState, event: AgentRunEvent): AgentTabState {
  if (tab.runId !== null && tab.runId !== event.runId) return tab;

  const mark = ordering.get(tab);
  if (mark && mark.runId === event.runId && event.seq <= mark.seq) return tab;

  const next = reduce(tab, event);
  if (next !== tab) ordering.set(next, { runId: event.runId, seq: event.seq });
  return next;
}
