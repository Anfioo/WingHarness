import type {
  ClaudeStatus,
  ControlRequest,
  SessionInfo,
  TranscriptItem,
  UseClaudeCodeOptions,
} from "./types";
import { extractToolResultText, parseQuestions, parseToolInput, type ClaudeEvent } from "./parser";

export interface SessionState {
  items: TranscriptItem[];
  status: ClaudeStatus;
  error: string | undefined;
  sessionId: string | undefined;
  sessionInfo: SessionInfo | null;
  /** Prompts the CLI is blocked on, in arrival order. The page answers the first. */
  pendingControls: ControlRequest[];
}

type OnUpdateFn = (state: SessionState) => void;

/**
 * Owns the state atom + subscriber list and folds ClaudeEvents into it.
 * Knows nothing about Tauri, IPC, or React.
 *
 * The transcript is a flat item list. Streaming writes into the item created by
 * the matching `content_block_start` (routed through `activeBlocks`, keyed by the
 * block's `index`); the authoritative `assistant`/`user` events then reconcile —
 * text/thinking are only appended when nothing was streamed, tool inputs are
 * overwritten by the parsed ones, and tool results attach by `tool_use_id`.
 */
export class StateManager {
  private state: SessionState;
  private listeners: Set<OnUpdateFn> = new Set();
  private opts: Pick<UseClaudeCodeOptions, "onFinish" | "onError">;

  /** Stream block index → transcript item id, for the current message. */
  private activeBlocks = new Map<number, string>();
  /** Transcript item ids created for the current message, per block kind. */
  private messageTextIds: string[] = [];
  private messageThinkingIds: string[] = [];
  /** Fallback target when a delta arrives without a `content_block_start`. */
  private openTextId: string | null = null;
  private openThinkingId: string | null = null;
  /** `tool_use.id` → transcript item id, for tool-result attachment. */
  private toolIdByUseId = new Map<string, string>();

  constructor(
    opts: Pick<
      UseClaudeCodeOptions,
      "onFinish" | "onError" | "initialItems" | "initialSessionId"
    > = {}
  ) {
    this.opts = opts;
    this.state = {
      // A restored history session starts with its transcript already in place;
      // its id is what makes the next message continue that conversation.
      items: [...(opts.initialItems ?? [])],
      status: "idle",
      error: undefined,
      sessionId: opts.initialSessionId,
      sessionInfo: null,
      pendingControls: [],
    };
  }

  subscribe(fn: OnUpdateFn): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): SessionState {
    return { ...this.state, items: [...this.state.items] };
  }

  private patch(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    const snap = this.snapshot();
    this.listeners.forEach((fn) => fn(snap));
  }

  /** Reset the per-message streaming bookkeeping at the start of a turn. */
  private resetStreaming(): void {
    this.activeBlocks.clear();
    this.messageTextIds = [];
    this.messageThinkingIds = [];
    this.openTextId = null;
    this.openThinkingId = null;
  }

  private ensureOpenText(items: TranscriptItem[], parent: string | null): string {
    if (this.openTextId) return this.openTextId;
    const id = crypto.randomUUID();
    items.push({
      kind: "assistant",
      id,
      text: "",
      streaming: true,
      parentToolUseId: parent,
    });
    this.openTextId = id;
    this.messageTextIds.push(id);
    return id;
  }

  private ensureOpenThinking(items: TranscriptItem[], parent: string | null): string {
    if (this.openThinkingId) return this.openThinkingId;
    const id = crypto.randomUUID();
    items.push({ kind: "thinking", id, text: "", streaming: true, parentToolUseId: parent });
    this.openThinkingId = id;
    this.messageThinkingIds.push(id);
    return id;
  }

  private appendText(items: TranscriptItem[], id: string, text: string): void {
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return;
    const item = items[i];
    if (item.kind === "assistant" || item.kind === "thinking") {
      items[i] = { ...item, text: item.text + text };
    }
  }

  startTurn(userId: string, userText: string): void {
    this.resetStreaming();
    this.toolIdByUseId.clear();
    this.patch({
      status: "submitted",
      error: undefined,
      items: [
        ...this.state.items,
        { kind: "user", id: userId, text: userText, parentToolUseId: null },
      ],
    });
  }

  setDisconnected(): void {
    this.patch({ status: "disconnected" });
  }

  /** Drop a control request the page has answered, so its dialog closes. */
  resolveControl(requestId: string): void {
    const pendingControls = this.state.pendingControls.filter(
      (control) => control.requestId !== requestId
    );
    if (pendingControls.length === this.state.pendingControls.length) return;
    this.patch({ pendingControls });
  }

  /**
   * Safety net for a stream that ends without a terminal `result` event: stop
   * any spinners rather than leaving the transcript stuck mid-turn. Any prompt
   * still open is dropped too — the process that was waiting on it is gone.
   */
  endTurn(): void {
    if (this.state.status === "idle" || this.state.status === "error") return;
    const items = this.state.items.map((it) => {
      if ((it.kind === "assistant" || it.kind === "thinking") && it.streaming) {
        return { ...it, streaming: false };
      }
      if (it.kind === "tool" && it.result === null) {
        return { ...it, result: { content: "", isError: true } };
      }
      return it;
    });
    this.patch({ items, status: "idle", pendingControls: [] });
  }

  setError(msg: string): void {
    this.patch({ status: "error", error: msg });
    this.opts.onError?.(new Error(msg));
  }

  apply(event: ClaudeEvent): void {
    let items = [...this.state.items];
    let error = this.state.error;
    let sessionId = this.state.sessionId;
    let sessionInfo = this.state.sessionInfo;

    const replace = (id: string, fn: (item: TranscriptItem) => TranscriptItem): void => {
      const i = items.findIndex((it) => it.id === id);
      if (i >= 0) items[i] = fn(items[i]);
    };

    // A prompt the CLI is blocked on: a tool permission, or the questions the
    // `AskUserQuestion` tool wants answered. The turn only continues once the
    // page replies, so this event is held until `resolveControl` clears it.
    if (event.type === "control_request") {
      const request = event.request ?? {};
      const input = request.input ?? {};
      this.patch({
        pendingControls: [
          ...this.state.pendingControls,
          {
            requestId: event.request_id,
            subtype: typeof request.subtype === "string" ? request.subtype : "",
            toolName: typeof request.tool_name === "string" ? request.tool_name : "",
            input,
            questions: parseQuestions(input),
            permissionSuggestions: request.permission_suggestions,
          },
        ],
      });
      return;
    }

    // Session init — store session_id for resume + session metadata.
    if (event.type === "system") {
      if (event.subtype === "init") {
        if (event.session_id) sessionId = event.session_id;
        sessionInfo = {
          model: event.model ?? null,
          permissionMode: event.permissionMode ?? null,
          tools: event.tools ?? [],
          mcpServers: (event.mcp_servers ?? []).map((s) => ({
            name: s.name,
            status: s.status,
          })),
        };
      }
      this.patch({ sessionId, sessionInfo });
      return;
    }

    if (event.type === "stream_event") {
      const inner = event.event;
      const parent = event.parent_tool_use_id ?? null;

      if (inner.type === "message_start") {
        this.resetStreaming();
        this.patch({ status: "streaming" });
        return;
      }

      if (inner.type === "content_block_start") {
        const block = inner.content_block;
        const index = inner.index;
        if (block?.type === "thinking") {
          const id = this.ensureOpenThinking(items, parent);
          this.activeBlocks.set(index, id);
        } else if (block?.type === "tool_use") {
          const id = crypto.randomUUID();
          const toolUseId = typeof block.id === "string" ? block.id : "";
          const toolName = typeof block.name === "string" ? block.name : "unknown";
          items.push({
            kind: "tool",
            id,
            toolUseId,
            toolName,
            input: {},
            inputPartial: "",
            result: null,
            parentToolUseId: parent,
          });
          if (toolUseId) this.toolIdByUseId.set(toolUseId, id);
          this.activeBlocks.set(index, id);
        } else {
          const id = this.ensureOpenText(items, parent);
          this.activeBlocks.set(index, id);
        }
        this.patch({ items, status: "streaming" });
        return;
      }

      if (inner.type === "content_block_delta") {
        const delta = inner.delta;
        if (!delta) return;
        const targetId = this.activeBlocks.get(inner.index);

        if (delta.type === "text_delta" && typeof delta.text === "string") {
          const chunk = delta.text;
          const id = targetId ?? this.ensureOpenText(items, parent);
          this.appendText(items, id, chunk);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          const chunk = delta.thinking;
          const id = targetId ?? this.ensureOpenThinking(items, parent);
          this.appendText(items, id, chunk);
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          targetId
        ) {
          const chunk = delta.partial_json;
          replace(targetId, (it) =>
            it.kind === "tool" ? { ...it, inputPartial: it.inputPartial + chunk } : it
          );
        }
        this.patch({ items, status: "streaming" });
        return;
      }

      if (inner.type === "content_block_stop") {
        const targetId = this.activeBlocks.get(inner.index);
        if (targetId) {
          replace(targetId, (it) => {
            if (it.kind !== "tool") return it;
            const parsed = parseToolInput(it.inputPartial);
            return parsed ? { ...it, input: parsed } : it;
          });
        }
        this.patch({ items });
        return;
      }

      if (inner.type === "message_stop") {
        items = items.map((it) =>
          (it.kind === "assistant" || it.kind === "thinking") && it.streaming
            ? { ...it, streaming: false }
            : it
        );
        this.patch({ items });
        return;
      }

      return;
    }

    // Full assistant message — finalize streamed items and reconcile tools.
    if (event.type === "assistant") {
      const blocks = event.message?.content ?? [];
      const parent = event.parent_tool_use_id ?? null;

      items = items.map((it) =>
        (it.kind === "assistant" || it.kind === "thinking") && it.streaming
          ? { ...it, streaming: false }
          : it
      );

      const hadStreamedText = this.messageTextIds.length > 0;
      const hadStreamedThinking = this.messageThinkingIds.length > 0;

      if (!hadStreamedText) {
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        const full = event.error ? `⚠ ${event.error}: ${text}` : text;
        if (full) {
          items.push({
            kind: "assistant",
            id: crypto.randomUUID(),
            text: full,
            streaming: false,
            parentToolUseId: parent,
          });
        }
      }

      if (!hadStreamedThinking) {
        for (const block of blocks) {
          if (block.type === "thinking" && block.thinking) {
            items.push({
              kind: "thinking",
              id: crypto.randomUUID(),
              text: block.thinking,
              streaming: false,
              parentToolUseId: parent,
            });
          }
        }
      }

      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const toolUseId = typeof block.id === "string" ? block.id : "";
        const existingId = toolUseId ? this.toolIdByUseId.get(toolUseId) : undefined;
        const input = block.input ?? {};
        if (existingId) {
          // Authoritative input wins over the streamed partial JSON.
          replace(existingId, (it) =>
            it.kind === "tool" ? { ...it, input, toolName: block.name || it.toolName } : it
          );
        } else {
          const id = crypto.randomUUID();
          items.push({
            kind: "tool",
            id,
            toolUseId,
            toolName: block.name ?? "unknown",
            input,
            inputPartial: "",
            result: null,
            parentToolUseId: parent,
          });
          if (toolUseId) this.toolIdByUseId.set(toolUseId, id);
        }
      }

      if (event.error) error = event.error;

      this.resetStreaming();
      this.patch({ items, status: "streaming", error });
      return;
    }

    // User message — carries tool results; attach them to their tool cards.
    if (event.type === "user") {
      const content = event.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      let touched = false;
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const id = toolUseId ? this.toolIdByUseId.get(toolUseId) : undefined;
        if (!id) continue;
        const isError = block.is_error === true;
        const text = extractToolResultText(block.content);
        replace(id, (it) =>
          it.kind === "tool" ? { ...it, result: { content: text, isError } } : it
        );
        touched = true;
      }
      if (touched) this.patch({ items });
      return;
    }

    // Result — terminal event for this turn.
    if (event.type === "result") {
      // A stopped turn is not a failure — the user asked for it. Whatever
      // streamed stays on screen, tools that never finished are marked stopped
      // rather than failed, and the turn closes without an error.
      const interrupted = event.subtype === "interrupted";
      const isError = !interrupted && (event.is_error === true || event.subtype !== "success");

      // A turn that ends without a tool result must not leave a spinner behind.
      items = items.map((it) => {
        if (it.kind !== "tool" || it.result !== null) return it;
        return interrupted
          ? { ...it, result: { content: "", isError: false, stopped: true } }
          : { ...it, result: { content: "", isError: true } };
      });

      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.kind === "assistant") {
          items[i] = { ...item, durationMs: event.duration_ms, isError: isError || item.isError };
          break;
        }
      }

      items.push({
        kind: "result",
        id: crypto.randomUUID(),
        subtype: event.subtype,
        isError,
        durationMs: event.duration_ms,
        totalCostUsd: event.total_cost_usd,
      });

      if (isError) {
        const message = event.result || event.subtype;
        this.patch({ items, status: "error", error: message, pendingControls: [] });
        this.opts.onError?.(new Error(message));
        return;
      }

      this.patch({ items, status: "idle", error: undefined, pendingControls: [] });

      // A stopped turn is over, but it is not a completed response.
      if (interrupted) return;

      const finishArg: { items: TranscriptItem[]; cost?: number } = {
        items: this.snapshot().items,
      };
      if (event.total_cost_usd !== undefined) finishArg.cost = event.total_cost_usd;
      this.opts.onFinish?.(finishArg);
      return;
    }
  }

  destroy(): void {
    this.listeners.clear();
  }
}
