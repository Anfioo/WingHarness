// Pure transcript helpers.
//
// A0 freezes the signatures; F2 fills the streaming behavior. Everything here
// returns a new array so React sees a changed reference per streamed tick.

import type { AgentMessageRow } from "../types";

/** Next row sequence: one past the current maximum (1 for an empty list). */
export function nextSeq(rows: AgentMessageRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
}

/**
 * Appends streamed assistant text. A trailing `assistant` row still marked
 * `live` is extended in place; otherwise a new row is started.
 */
export function appendDelta(rows: AgentMessageRow[], text: string): AgentMessageRow[] {
  const last = rows[rows.length - 1];
  if (last && last.kind === "assistant" && last.live) {
    const updated: AgentMessageRow = { ...last, text: last.text + text };
    return [...rows.slice(0, -1), updated];
  }
  return [...rows, { kind: "assistant", seq: nextSeq(rows), text, ts: null, live: true }];
}

/** Same accumulation rule as `appendDelta`, for the reasoning stream. */
export function appendThinking(rows: AgentMessageRow[], text: string): AgentMessageRow[] {
  const last = rows[rows.length - 1];
  if (last && last.kind === "thinking" && last.live) {
    const updated: AgentMessageRow = { ...last, text: last.text + text };
    return [...rows.slice(0, -1), updated];
  }
  return [...rows, { kind: "thinking", seq: nextSeq(rows), text, live: true, collapsed: false }];
}

/** What a tool event contributes; omitted fields keep the row's value. */
export type AgentToolUpdate = {
  seq?: number;
  toolName: string;
  toolCallId?: string | null;
  path?: string | null;
  args?: unknown;
  result?: unknown;
  status?: "running" | "done" | "error" | "stopped";
  startedAt?: number;
};

/**
 * Inserts or updates the tool row identified by `toolCallId` (or, when the
 * event carries none, by `seq`).
 */
export function upsertToolRow(rows: AgentMessageRow[], update: AgentToolUpdate): AgentMessageRow[] {
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
    result: update.result ?? current.result,
    status: update.status ?? current.status,
  };
  return [...rows.slice(0, index), updated, ...rows.slice(index + 1)];
}
