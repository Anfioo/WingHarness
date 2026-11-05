/**
 * Stored history records → the transcript items the chat renderer takes.
 *
 * Both the chat page's history drawer and the history viewer show a stored
 * session through the same transcript, so the conversion lives here rather than
 * in either page.
 */

import type { ClaudeHistoryRecord } from "@/commands";
import { extractToolResultText } from "./parser";
import type { ToolResult, TranscriptItem } from "./types";

export function toTranscriptItems(records: ClaudeHistoryRecord[]): TranscriptItem[] {
  return records.map((record, index) => {
    // One assistant message becomes several records sharing a uuid, so the index
    // is what keeps the React keys unique.
    const id = `history-${index}`;
    switch (record.kind) {
      case "user":
        return { kind: "user", id, text: record.text, parentToolUseId: null };
      case "assistant":
        return {
          kind: "assistant",
          id,
          text: record.text,
          streaming: false,
          parentToolUseId: record.parentToolUseId,
        };
      case "thinking":
        return {
          kind: "thinking",
          id,
          text: record.text,
          streaming: false,
          parentToolUseId: record.parentToolUseId,
        };
      case "tool":
        return {
          kind: "tool",
          id,
          toolUseId: record.toolUseId ?? id,
          toolName: record.toolName ?? "unknown",
          input: record.input ?? {},
          inputPartial: "",
          result: toolResult(record),
          parentToolUseId: record.parentToolUseId,
        };
    }
  });
}

/**
 * A stored tool call usually has its result stored with it; when it does not,
 * the session was interrupted or compacted before the tool answered. That is
 * reported as `stopped` — a null result would render an eternal spinner.
 */
function toolResult(record: ClaudeHistoryRecord): ToolResult {
  if (record.resultContent == null) {
    return { content: "", isError: false, stopped: true };
  }
  return {
    content: extractToolResultText(record.resultContent),
    isError: record.isError === true,
  };
}
