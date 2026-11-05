/**
 * Domain types for the Claude Code chat session.
 *
 * Vendored from `@ekaone/use-claude` (MIT). The npm release of that package
 * ships an `exports` map pointing at files it never publishes, so the source is
 * inlined here instead of installed.
 *
 * The transcript is a flat, ordered list of discriminated items rather than a
 * text-only bubble: `stream-json` carries tool calls, tool results and thinking
 * blocks alongside assistant text, and a flat array keeps streaming (append or
 * patch one item) and tool-result attachment (lookup by `toolUseId`) cheap.
 * Sub-agent output is not nested in the reducer — those items simply carry the
 * parent tool's `parentToolUseId`, and the view decides how to indent them.
 */

/** One transcript entry. `kind` is the discriminant. */
export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      text: string;
      parentToolUseId: null;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      /** True while token deltas are still arriving for this message. */
      streaming: boolean;
      parentToolUseId: string | null;
      /** Filled from the terminal `result` event. */
      durationMs?: number;
      isError?: boolean;
    }
  | {
      kind: "thinking";
      id: string;
      text: string;
      streaming: boolean;
      parentToolUseId: string | null;
    }
  | {
      kind: "tool";
      id: string;
      /** The API's `tool_use.id`; matches the `tool_result.tool_use_id`. */
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      /** Accumulated `input_json_delta` until the authoritative event lands. */
      inputPartial: string;
      result: ToolResult | null;
      parentToolUseId: string | null;
    }
  | {
      kind: "result";
      id: string;
      subtype: string;
      isError: boolean;
      durationMs?: number;
      totalCostUsd?: number;
    };

export interface ToolResult {
  content: string;
  isError: boolean;
  /** The turn was stopped while this tool was still running. Not a failure:
   * the tool simply never reported a result. */
  stopped?: boolean;
}

/** Session-level metadata pulled from the first `system/init` event. */
export interface SessionInfo {
  model: string | null;
  permissionMode: string | null;
  tools: string[];
  mcpServers: { name: string; status: string }[];
}

export type ClaudeStatus = "idle" | "submitted" | "streaming" | "error" | "disconnected";

/** One choice inside a `ControlQuestion`. */
export interface ControlQuestionOption {
  label: string;
  description?: string;
  /** Long-form body a capable UI may render beside the option. */
  preview?: string;
}

/** One question the `AskUserQuestion` tool wants the user to answer. */
export interface ControlQuestion {
  question: string;
  header?: string;
  options: ControlQuestionOption[];
  multiSelect?: boolean;
}

/**
 * A prompt the CLI is blocked on. Both the tool-permission prompt and
 * `AskUserQuestion` arrive on the same channel; `questions` is non-empty only
 * for the latter, which is what the dialog switches on.
 */
export interface ControlRequest {
  requestId: string;
  subtype: string;
  toolName: string;
  input: Record<string, unknown>;
  questions: ControlQuestion[];
  /**
   * The CLI's own one-click permission changes for this prompt (typically
   * `setMode`, `addDirectories` or `addRules` entries), passed back verbatim as
   * `updatedPermissions`. Absent when the CLI proposes nothing.
   */
  permissionSuggestions?: unknown;
}

/**
 * The host's verdict for a `ControlRequest`, sent back verbatim as the CLI's
 * `can_use_tool` payload. `updatedInput` is how an `AskUserQuestion` answer
 * travels: the tool input, plus an `answers` map keyed by question text (an
 * array of labels for a multi-select question). `updatedPermissions` applies a
 * `permission_suggestions` list the CLI offered with the request.
 */
export type ControlResponse =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export interface UseClaudeCodeOptions {
  /** Working directory passed to Claude Code CLI. Defaults to '.' */
  cwd?: string;
  /** Override the Claude model. e.g. 'claude-sonnet-4-5' */
  model?: string;
  /** Maps to `--permission-mode`: manual | acceptEdits | auto | dontAsk | plan | bypassPermissions. */
  permissionMode?: string;
  /**
   * Transcript to open the session with, and the id to continue it from — how a
   * session picked in the history drawer is restored. Like every other option
   * here, both are read once at construction.
   */
  initialItems?: TranscriptItem[];
  initialSessionId?: string;
  /** Called when a full response finishes streaming */
  onFinish?: (opts: { items: TranscriptItem[]; cost?: number }) => void;
  /** Called on error */
  onError?: (err: Error) => void;
}

/**
 * Where a line of bridge traffic came from: the command that ran, a frame
 * written to the CLI's stdin, a line read from its stdout or stderr, or an
 * event the host synthesized when the process ended.
 */
export type CliLogDirection = "spawn" | "in" | "out" | "err" | "sys";

/** One line of the CLI bridge, as shown in the log drawer. */
export interface CliLogEntry {
  id: number;
  dir: CliLogDirection;
  text: string;
  /** Arrival time, epoch milliseconds. */
  at: number;
}

export interface UseClaudeCodeReturn {
  items: TranscriptItem[];
  status: ClaudeStatus;
  error: string | undefined;
  /** The session being continued; the next message resumes it. */
  sessionId: string | undefined;
  sessionInfo: SessionInfo | null;
  /** The prompt the CLI is blocked on, if any. The page must answer it. */
  pendingControl: ControlRequest | null;
  /** Raw traffic between this host and the CLI, oldest first, capped. */
  logs: CliLogEntry[];
  sendMessage: (text: string) => Promise<void>;
  /** Stop the turn that is running, if any. */
  interrupt: () => Promise<void>;
  /** Answer `pendingControl` so the turn can continue. */
  respond: (requestId: string, response: ControlResponse) => Promise<void>;
  /** Drop every collected log line. */
  clearLogs: () => void;
}
