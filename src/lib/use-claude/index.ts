import { useState, useEffect, useCallback } from "react";
import { ClaudeSession } from "./session";
import { type SessionState } from "./state";
import type {
  CliLogEntry,
  ControlResponse,
  UseClaudeCodeOptions,
  UseClaudeCodeReturn,
} from "./types";

/**
 * React hook for talking to the local Claude Code CLI over Tauri IPC.
 *
 * Adapted from `@ekaone/use-claude/react` (MIT) — see types.ts for why the npm
 * package is not used directly. The session is held in state rather than a ref
 * so it is created once and never read during render (React 19's refs rule).
 */
export function useClaudeCode(opts: UseClaudeCodeOptions = {}): UseClaudeCodeReturn {
  // Stable session instance — created once, survives re-renders.
  const [session] = useState(() => new ClaudeSession(opts));

  const [state, setState] = useState<SessionState>(() => session.getState());
  const [logs, setLogs] = useState<CliLogEntry[]>(() => session.getLogs());

  const { cwd, model, permissionMode } = opts;

  // Model and permission mode are per-turn, not per-session: sending the next
  // message with a different one is how the CLI's own `/model` behaves, so the
  // conversation carries on instead of being thrown away.
  useEffect(() => {
    session.updateOptions({ cwd, model, permissionMode });
  }, [session, cwd, model, permissionMode]);

  useEffect(() => {
    // Bridge core callbacks → React state.
    const unsubscribe = session.onUpdate((next) => setState(next));
    const unsubscribeLogs = session.onLog(setLogs);
    const detachLogs = session.attachLogs();

    return () => {
      unsubscribe();
      unsubscribeLogs();
      detachLogs();
      session.destroy();
    };
  }, [session]);

  const sendMessage = useCallback(
    async (text: string) => {
      await session.send(text);
    },
    [session]
  );

  const interrupt = useCallback(async () => {
    await session.interrupt();
  }, [session]);

  const respond = useCallback(
    async (requestId: string, response: ControlResponse) => {
      await session.respond(requestId, response);
    },
    [session]
  );

  const clearLogs = useCallback(() => {
    session.clearLogs();
  }, [session]);

  return {
    items: state.items,
    status: state.status,
    error: state.error,
    sessionId: state.sessionId,
    sessionInfo: state.sessionInfo,
    pendingControl: state.pendingControls[0] ?? null,
    logs,
    sendMessage,
    interrupt,
    respond,
    clearLogs,
  };
}
