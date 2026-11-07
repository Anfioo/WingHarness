// DTOs and error discrimination for the Agent chat page.
//
// Mirrors `agent-chat-core/src/models.rs` and `error.rs`. Every field is
// camelCase on the wire. This module is frozen: the lanes consume it as-is.

/** Stable error codes returned by every `agent_*` command. */
export type AgentChatErrorCode =
  | "not-found"
  | "invalid-input"
  | "engine-unavailable"
  | "not-running"
  | "conflict"
  | "unsupported"
  | "internal"
  | "not-implemented";

/** Shape of a rejected `agent_*` command. */
export type AgentChatError = {
  code: AgentChatErrorCode;
  message: string;
  detail: string | null;
};

const AGENT_CHAT_ERROR_CODES = new Set<string>([
  "not-found",
  "invalid-input",
  "engine-unavailable",
  "not-running",
  "conflict",
  "unsupported",
  "internal",
  "not-implemented",
]);

/** Narrow a rejected command to the engine's error type. */
export function isAgentChatError(value: unknown): value is AgentChatError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && AGENT_CHAT_ERROR_CODES.has(code);
}

/** `code` of a rejected command, or `null` when it came from somewhere else. */
export function agentChatErrorCode(value: unknown): AgentChatErrorCode | null {
  return isAgentChatError(value) ? value.code : null;
}

/** One engine as the picker renders it. */
export type AgentEngineInfo = {
  id: string;
  label: string;
  available: boolean;
  bin: string | null;
  models: string[];
  supportsEffort: boolean;
  permissions: string[];
  transport: "child" | "own";
};

/** What `agent_send` accepts for one turn. */
export type AgentSendInput = {
  engine: string;
  workspacePath: string;
  sessionId: string | null;
  prompt: string;
  model: string | null;
  effort: string | null;
  permission: string | null;
  additionalDirs: string[] | null;
  runId: string | null;
};

/** What `agent_send` hands back once the turn has a run id. */
export type AgentSendResult = {
  runId: string;
  sessionId: string | null;
};

/** One normalized run event, as carried by the `agent:event` batch. */
export type AgentRunEvent = {
  runId: string;
  sessionId: string | null;
  engine: string;
  seq: number;
  kind: string;
  data: unknown;
  ts: number;
};

/** A native session file, summarized for the sidebar. */
export type AgentSessionMeta = {
  engine: string;
  sessionId: string;
  workspacePath: string;
  filePath: string;
  fileSize: number;
  fileMtimeMs: number;
  title: string;
  preview: string;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
};

/** One transcript row read from a native session file. */
export type AgentMessage = {
  seq: number;
  role: "user" | "assistant" | "thinking" | "tool";
  text: string;
  ts: string | null;
  path: string | null;
  args: unknown;
  result: unknown;
  toolCallId: string | null;
  model: string | null;
  usage: unknown;
};

/** One page of a native session transcript. */
export type AgentSessionPage = {
  messages: AgentMessage[];
  nextBefore: number | null;
};

/** One open tab, as persisted in `ui.json`. */
export type AgentTab = {
  tabId: string;
  engine: string;
  sessionId: string | null;
  workspacePath: string;
};

/** Per-engine model/effort/permission choices. */
export type AgentEnginePrefs = {
  model: string | null;
  effort: string | null;
  permission: string | null;
};

/** Everything the page persists: `ui.json`. */
export type AgentUiState = {
  version: number;
  openTabs: AgentTab[];
  activeTabId: string | null;
  lastEngine: string;
  engines: Record<string, AgentEnginePrefs>;
  grants: Record<string, string[]>;
  recentWorkspaces: string[];
};

/** Question answers keyed by question id; `null` means "skip". */
export type AgentAnswerMap = Record<string, string | string[]>;
