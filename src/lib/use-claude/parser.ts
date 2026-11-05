/**
 * ClaudeEvent types + parseNDJSON(), vendored from `@ekaone/use-claude` (MIT).
 *
 * The shapes mirror `claude --print --output-format stream-json
 * --include-partial-messages` output (verified against claude 2.1.x). We keep
 * only the fields the reducer consumes; unknown top-level events are tolerated
 * so a future CLI version degrades to "ignored" rather than "crash".
 */

import type { ControlQuestion, ControlQuestionOption } from "./types";

/**
 * A content block inside an assistant/user message. Modelled as one loose
 * interface (rather than a discriminated union) because the CLI adds block
 * kinds over time and every field is optional in practice.
 */
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

/** The raw Anthropic stream event carried by a `stream_event` envelope. */
export type AnthropicStreamEvent =
  | { type: "message_start"; [k: string]: unknown }
  | {
      type: "content_block_start";
      index: number;
      content_block?: ContentBlock;
      [k: string]: unknown;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta?: {
        type: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    }
  | { type: "content_block_stop"; index: number; [k: string]: unknown }
  | { type: "message_delta"; [k: string]: unknown }
  | { type: "message_stop"; [k: string]: unknown };

export interface SystemEvent {
  type: "system";
  subtype: string;
  session_id?: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  model?: string;
  permissionMode?: string;
  claude_code_version?: string;
}

export interface StreamEvent {
  type: "stream_event";
  event: AnthropicStreamEvent;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
}

export interface AssistantEvent {
  type: "assistant";
  message: { content: ContentBlock[] };
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  error?: string;
}

export interface UserEvent {
  type: "user";
  message: { content: ContentBlock[] | string };
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
}

export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  total_cost_usd?: number;
  usage?: unknown;
  session_id?: string;
}

/**
 * A prompt the CLI is blocking on, emitted because the run was started with
 * `--permission-prompts host`. Covers both a tool-permission prompt and
 * `AskUserQuestion` (which arrives as a `can_use_tool` request for the tool of
 * that name). The turn does not continue until the host replies.
 */
export interface ControlRequestEvent {
  type: "control_request";
  request_id: string;
  request: {
    subtype: string;
    tool_name?: string;
    tool_use_id?: string;
    input?: Record<string, unknown>;
    permission_suggestions?: unknown;
    decision_reason?: string;
    mcp_server?: string;
    [k: string]: unknown;
  };
  session_id?: string;
}

/**
 * Every event type the reducer knows about. An event with an unmodelled `type`
 * still parses and reaches the reducer — it just matches no branch and is
 * dropped, which is what a CLI that grew a new event should do here.
 *
 * The union has no catch-all member on purpose: a `{ type: string }` arm would
 * defeat discriminated narrowing on `event.type`.
 */
export type ClaudeEvent =
  | SystemEvent
  | StreamEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | ControlRequestEvent;

/**
 * Converts a raw NDJSON line from stdout into a typed ClaudeEvent.
 * Returns null for blank lines or malformed JSON — callers skip null.
 */
export function parseNDJSON(line: string): ClaudeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeEvent;
  } catch {
    return null;
  }
}

/** Extract plain text from an AssistantEvent content array. */
export function extractText(event: AssistantEvent): string {
  return event.message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Flatten a `tool_result.content` value into display text. It is a string for
 * most tools, an array of `{ text }` blocks for others, and occasionally an
 * arbitrary object.
 */
export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) {
          return String((c as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/** Parse accumulated `input_json_delta` text; null when it is not valid JSON. */
export function parseToolInput(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** MCP tools arrive as `mcp__<server>__<tool>`. */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!isMcpTool(name)) return null;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * Read the `questions` array out of an `AskUserQuestion` tool input.
 *
 * The payload is model-authored, so every field is treated as untrusted: a
 * question with no usable options is dropped rather than rendered as a dialog
 * with nothing to click.
 */
export function parseQuestions(input: Record<string, unknown> | undefined): ControlQuestion[] {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return [];

  const questions: ControlQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.question !== "string") continue;

    const options: ControlQuestionOption[] = [];
    for (const option of Array.isArray(value.options) ? value.options : []) {
      if (!option || typeof option !== "object") continue;
      const fields = option as Record<string, unknown>;
      if (typeof fields.label !== "string") continue;
      const parsed: ControlQuestionOption = { label: fields.label };
      if (typeof fields.description === "string") parsed.description = fields.description;
      if (typeof fields.preview === "string") parsed.preview = fields.preview;
      options.push(parsed);
    }
    if (options.length === 0) continue;

    const question: ControlQuestion = { question: value.question, options };
    if (typeof value.header === "string") question.header = value.header;
    if (value.multiSelect === true) question.multiSelect = true;
    questions.push(question);
  }

  return questions;
}
