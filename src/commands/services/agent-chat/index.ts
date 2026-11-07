// Agent chat command service.
//
// Thin, one-to-one wrappers over the `agent-chat-core` Rust commands. Argument
// keys are camelCase here; Tauri maps them onto the snake_case Rust parameters.
// This module is frozen: the lanes use it as-is.
//
// Rejected calls throw the engine's `{ code, message, detail }` object; use
// `isAgentChatError` / `agentChatErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
import type {
  AgentAnswerMap,
  AgentEngineInfo,
  AgentSendInput,
  AgentSendResult,
  AgentSessionMeta,
  AgentSessionPage,
  AgentUiState,
} from "./types";

export async function agentListEngines(): Promise<AgentEngineInfo[]> {
  return await invokeCommand<Record<string, never>, AgentEngineInfo[]>("agent_list_engines", {});
}

export async function agentSend(input: AgentSendInput): Promise<AgentSendResult> {
  return await invokeCommand<{ input: AgentSendInput }, AgentSendResult>("agent_send", { input });
}

export async function agentInterrupt(runId: string): Promise<boolean> {
  return await invokeCommand<{ runId: string }, boolean>("agent_interrupt", { runId });
}

export async function agentLiveRuns(runIds: string[]): Promise<string[]> {
  return await invokeCommand<{ runIds: string[] }, string[]>("agent_live_runs", { runIds });
}

export async function agentAnswer(
  runId: string,
  requestId: string,
  answers: AgentAnswerMap | null
): Promise<void> {
  return await invokeCommand<
    { runId: string; requestId: string; answers: AgentAnswerMap | null },
    void
  >("agent_answer", { runId, requestId, answers });
}

export async function agentListSessions(
  engine?: string | null,
  workspacePath?: string | null,
  limit?: number
): Promise<AgentSessionMeta[]> {
  return await invokeCommand<
    { engine: string | null; workspacePath: string | null; limit: number | null },
    AgentSessionMeta[]
  >("agent_list_sessions", {
    engine: engine ?? null,
    workspacePath: workspacePath ?? null,
    limit: limit ?? null,
  });
}

export async function agentLoadSession(
  engine: string,
  sessionId: string,
  workspacePath: string,
  limit?: number,
  beforeSeq?: number | null
): Promise<AgentSessionPage> {
  return await invokeCommand<
    {
      engine: string;
      sessionId: string;
      workspacePath: string;
      limit: number | null;
      beforeSeq: number | null;
    },
    AgentSessionPage
  >("agent_load_session", {
    engine,
    sessionId,
    workspacePath,
    limit: limit ?? null,
    beforeSeq: beforeSeq ?? null,
  });
}

export async function agentUiGet(): Promise<AgentUiState> {
  return await invokeCommand<Record<string, never>, AgentUiState>("agent_ui_get", {});
}

export async function agentUiSet(state: AgentUiState): Promise<void> {
  return await invokeCommand<{ state: AgentUiState }, void>("agent_ui_set", { state });
}

export * from "./types";
