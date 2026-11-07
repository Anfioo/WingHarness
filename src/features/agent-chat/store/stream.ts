// Pure transcript helpers.
//
// Everything here returns a new array so React sees a changed reference per
// streamed tick. The store and F2's event projection both call these.

import type { AgentMessage } from "@/commands/services/agent-chat/types";
import type { AgentMessageRow } from "../types";

/** Next row sequence: one past the current maximum (1 for an empty list). */
export function nextSeq(rows: AgentMessageRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
}

/** Appends a user turn. */
export function appendUser(
  rows: AgentMessageRow[],
  text: string,
  ts: string | null = null
): AgentMessageRow[] {
  return [...rows, { kind: "user", seq: nextSeq(rows), text, ts }];
}

/**
 * Appends streamed assistant text. A trailing `assistant` row still marked
 * `live` is extended in place; otherwise a new row is started.
 */
export function appendDelta(
  rows: AgentMessageRow[],
  text: string,
  ts: string | null = null
): AgentMessageRow[] {
  const last = rows[rows.length - 1];
  if (last && last.kind === "assistant" && last.live) {
    const updated: AgentMessageRow = { ...last, text: last.text + text };
    return [...rows.slice(0, -1), updated];
  }
  return [...rows, { kind: "assistant", seq: nextSeq(rows), text, ts, live: true }];
}

/** Same accumulation rule as `appendDelta`, for the reasoning stream. */
export function appendThinking(
  rows: AgentMessageRow[],
  text: string,
  _ts: string | null = null
): AgentMessageRow[] {
  // Thinking rows carry no timestamp; the argument keeps the signature uniform.
  void _ts;
  const last = rows[rows.length - 1];
  if (last && last.kind === "thinking" && last.live) {
    const updated: AgentMessageRow = { ...last, text: last.text + text };
    return [...rows.slice(0, -1), updated];
  }
  return [...rows, { kind: "thinking", seq: nextSeq(rows), text, live: true, collapsed: false }];
}

/** What a tool event contributes; omitted fields keep the row's value. */
export type ToolRowPatch = {
  seq?: number;
  toolName: string;
  toolCallId?: string | null;
  path?: string | null;
  args?: unknown;
  result?: unknown;
  status?: "running" | "done" | "error" | "stopped";
  startedAt?: number;
};

export type AgentToolUpdate = ToolRowPatch;

/**
 * Inserts or updates the tool row identified by `toolCallId` (or, when the
 * event carries none, by `seq`).
 *
 * A row's `result` only ever moves from null to a value once; a late duplicate
 * is dropped so the first observed outcome wins.
 */
export function upsertToolRow(rows: AgentMessageRow[], update: ToolRowPatch): AgentMessageRow[] {
  const index = rows.findIndex((row) => {
    if (row.kind !== "tool") return false;
    if (update.toolCallId && row.toolCallId) return row.toolCallId === update.toolCallId;
    return update.seq !== undefined && row.seq === update.seq;
  });

  if (index === -1) {
    return [
      ...rows,
      {
        kind: "tool",
        seq: update.seq ?? nextSeq(rows),
        toolName: update.toolName,
        toolCallId: update.toolCallId ?? null,
        path: update.path ?? null,
        args: update.args ?? null,
        result: update.result ?? null,
        status: update.status ?? "running",
        startedAt: update.startedAt ?? Date.now(),
      },
    ];
  }

  const current = rows[index];
  if (current.kind !== "tool") return rows;
  const updated: AgentMessageRow = {
    ...current,
    toolName: update.toolName || current.toolName,
    toolCallId: update.toolCallId ?? current.toolCallId,
    path: update.path ?? current.path,
    args: update.args ?? current.args,
    result: current.result == null ? (update.result ?? null) : current.result,
    status: update.status ?? current.status,
  };
  return [...rows.slice(0, index), updated, ...rows.slice(index + 1)];
}

/** Marks every live assistant/thinking row as settled. */
export function settleLiveRows(rows: AgentMessageRow[]): AgentMessageRow[] {
  return rows.map((row) => {
    if ((row.kind === "assistant" || row.kind === "thinking") && row.live) {
      return { ...row, live: false };
    }
    return row;
  });
}

/** Converts native-session rows into timeline rows for the initial page. */
export function rowsFromMessages(messages: AgentMessage[]): AgentMessageRow[] {
  const sorted = [...messages].sort((left, right) => left.seq - right.seq);
  return sorted.map((message): AgentMessageRow => {
    switch (message.role) {
      case "user":
        return { kind: "user", seq: message.seq, text: message.text, ts: message.ts };
      case "assistant":
        return {
          kind: "assistant",
          seq: message.seq,
          text: message.text,
          ts: message.ts,
          live: false,
        };
      case "thinking":
        return {
          kind: "thinking",
          seq: message.seq,
          text: message.text,
          live: false,
          collapsed: true,
        };
      case "tool":
        return {
          kind: "tool",
          seq: message.seq,
          toolName: message.text || "tool",
          toolCallId: message.toolCallId,
          path: message.path,
          args: message.args,
          result: message.result,
          status: message.result == null ? "stopped" : "done",
          startedAt: message.ts ? Date.parse(message.ts) || 0 : 0,
        };
    }
  });
}
