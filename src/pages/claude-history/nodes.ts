/**
 * Stored records → the nodes the viewer draws.
 *
 * A node is one thing someone said: a user message, or the text of one
 * assistant message. Everything the CLI did on the way there — tool calls and
 * thinking — is folded into the count on the node, because the node view is
 * about the conversation, not about the plumbing.
 *
 * The records of one assistant message share its `uuid`, so grouping by uuid is
 * also what keeps "let me look at that" together with the two tools it launches.
 * A message with no text at all (a bare tool call) is not a node: its counts
 * wait for the next node, which is the message those tools were a step toward.
 */

import type { ClaudeHistoryRecord } from "@/commands";

export type NodeRole = "user" | "assistant";

export interface ConversationNode {
  /** Stable key for React; the index of the first record it was built from. */
  id: string;
  role: NodeRole;
  text: string;
  /** Tool calls made toward this message. */
  tools: number;
  /** Thinking blocks folded into this message. */
  thoughts: number;
  /** The row's own time, as stored. */
  timestamp?: string;
  /** The message a fork of this node branches from. */
  uuid: string;
  /**
   * The CLI had finished this reply and was waiting for the user: nothing was
   * said after it but the user's next message. This is the message a fork
   * usually wants.
   */
  awaitingInput: boolean;
}

export function toNodes(records: ClaudeHistoryRecord[]): ConversationNode[] {
  const nodes: ConversationNode[] = [];
  // Counts for a message that has no text of its own yet.
  let pendingTools = 0;
  let pendingThoughts = 0;

  let index = 0;
  while (index < records.length) {
    const uuid = records[index].uuid;
    let end = index;
    let role: NodeRole | null = null;
    let text = "";
    let tools = 0;
    let thoughts = 0;

    while (end < records.length && records[end].uuid === uuid) {
      const record = records[end];
      if (record.kind === "tool") tools += 1;
      else if (record.kind === "thinking") thoughts += 1;
      else if (role === null && record.text.trim()) {
        role = record.kind as NodeRole;
        text = record.text;
      }
      end += 1;
    }

    if (role === null) {
      pendingTools += tools;
      pendingThoughts += thoughts;
    } else {
      nodes.push({
        id: `node-${index}`,
        role,
        text,
        tools: tools + pendingTools,
        thoughts: thoughts + pendingThoughts,
        timestamp: records[index].timestamp,
        uuid,
        // Filled in once the whole list is known: it depends on the next node.
        awaitingInput: false,
      });
      pendingTools = 0;
      pendingThoughts = 0;
    }

    index = end;
  }

  return nodes.map((node, position) => ({
    ...node,
    awaitingInput:
      node.role === "assistant" &&
      (position === nodes.length - 1 || nodes[position + 1].role === "user"),
  }));
}
