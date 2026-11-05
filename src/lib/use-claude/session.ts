/**
 * Tauri IPC orchestration for one chat session.
 * No state logic, no parsing — those live in state.ts and parser.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { parseNDJSON } from "./parser";
import { StateManager, type SessionState } from "./state";
import type { CliLogDirection, CliLogEntry, ControlResponse, UseClaudeCodeOptions } from "./types";

/** Lines kept for the log drawer. Older ones are dropped: the drawer only ever
 * shows what is still recent, and an unbounded list is what makes it lag. */
const MAX_LOG_ENTRIES = 300;
/** Characters kept per line. Tool results can be hundreds of kilobytes, and a
 * few hundred of those is more than the drawer can render smoothly. */
const MAX_LOG_TEXT = 8000;

const DIRECTIONS: CliLogDirection[] = ["spawn", "in", "out", "err", "sys"];

function toDirection(value: string): CliLogDirection {
  return DIRECTIONS.find((dir) => dir === value) ?? "sys";
}

type LogListener = (logs: CliLogEntry[]) => void;

export class ClaudeSession {
  private opts: UseClaudeCodeOptions;
  private sm: StateManager;
  private unlistens: UnlistenFn[] = [];
  private logs: CliLogEntry[] = [];
  private logListeners = new Set<LogListener>();
  private logSeq = 0;

  constructor(opts: UseClaudeCodeOptions = {}) {
    this.opts = opts;

    const smOpts: Pick<
      UseClaudeCodeOptions,
      "onFinish" | "onError" | "initialItems" | "initialSessionId"
    > = {};
    if (opts.onFinish !== undefined) smOpts.onFinish = opts.onFinish;
    if (opts.onError !== undefined) smOpts.onError = opts.onError;
    if (opts.initialItems !== undefined) smOpts.initialItems = opts.initialItems;
    if (opts.initialSessionId !== undefined) smOpts.initialSessionId = opts.initialSessionId;

    this.sm = new StateManager(smOpts);
  }

  /**
   * Subscribes to the bridge's log stream, for the whole session rather than one
   * turn: the drawer shows the traffic of every turn so far, including the ones
   * sent before it was opened.
   *
   * Called from the hook's effect instead of the constructor because StrictMode
   * unmounts and remounts once in development — a listener registered in the
   * constructor is unsubscribed by that first cleanup and never comes back.
   */
  attachLogs(): () => void {
    let active = true;
    const pending = listen<{ dir: string; text: string }>("claude-log", (event) => {
      if (active) this.appendLog(event.payload.dir, event.payload.text);
    });
    return () => {
      active = false;
      void pending.then((fn) => fn());
    };
  }

  onUpdate(fn: (state: SessionState) => void): () => void {
    return this.sm.subscribe(fn);
  }

  getState(): SessionState {
    return this.sm.snapshot();
  }

  /** Applies option changes to the *next* turn. A running turn keeps the ones
   * it was started with, so the drawer never shows a half-switched invocation. */
  updateOptions(patch: Partial<UseClaudeCodeOptions>): void {
    Object.assign(this.opts, patch);
  }

  onLog(fn: LogListener): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  getLogs(): CliLogEntry[] {
    return this.logs;
  }

  clearLogs(): void {
    if (this.logs.length === 0) return;
    this.logs = [];
    this.notifyLogs();
  }

  private appendLog(dir: string, text: string): void {
    const entry: CliLogEntry = {
      id: ++this.logSeq,
      dir: toDirection(dir),
      text: text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text,
      at: Date.now(),
    };
    this.logs = [...this.logs, entry].slice(-MAX_LOG_ENTRIES);
    this.notifyLogs();
  }

  private notifyLogs(): void {
    this.logListeners.forEach((fn) => fn(this.logs));
  }

  async send(text: string): Promise<void> {
    // An id to resume from, when a previous turn has established a session.
    const resume = this.sm.snapshot().sessionId ?? "";

    const userId: string = crypto.randomUUID();

    // 1. Optimistic state update — append the user turn and reset per-turn
    //    streaming bookkeeping (assistant items appear when output arrives).
    this.sm.startTurn(userId, text);

    // 2. Wire Tauri event listeners before invoking (avoid race)
    const unlisten = await listen<string>("claude-event", (e) => {
      const event = parseNDJSON(e.payload);
      if (event) this.sm.apply(event);
    });

    const unlistenDone = await listen<string>("claude-done", () => {
      // The stream is over; make sure nothing is left spinning.
      this.sm.endTurn();
      unlisten();
      unlistenDone();
    });

    this.unlistens.push(unlisten, unlistenDone);

    // 3. Invoke the Rust command
    try {
      await invoke("send_to_claude", {
        prompt: text,
        cwd: this.opts.cwd ?? ".",
        model: this.opts.model ?? "",
        resume,
        permissionMode: this.opts.permissionMode ?? "",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sm.setError(msg);
      unlisten();
      unlistenDone();
    }
  }

  /**
   * Stop the running turn. The Rust side kills the Claude process tree; the
   * stream then ends with an `interrupted` result, which closes the turn
   * without an error.
   */
  async interrupt(): Promise<void> {
    try {
      await invoke("interrupt_claude");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sm.setError(msg);
    }
  }

  /**
   * Answer the prompt the CLI is blocked on — a tool permission, or the
   * questions `AskUserQuestion` is waiting for. The reply is written to the
   * still-open stdin of the running process, and the request is dropped from
   * the pending list so its dialog closes.
   */
  async respond(requestId: string, response: ControlResponse): Promise<void> {
    try {
      await invoke("respond_claude_control", { requestId, response });
      this.sm.resolveControl(requestId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sm.setError(msg);
    }
  }

  destroy(): void {
    this.unlistens.forEach((fn) => fn());
    this.unlistens = [];
    this.logListeners.clear();
    this.sm.destroy();
  }
}
