// The Agent chat store's frozen interface.
//
// F1 owns the implementation in `../store.ts`; this file only declares the
// contract so F2/F3 can import it without depending on F1's internals.

import type {
  AgentAnswerMap,
  AgentEngineInfo,
  AgentEnginePrefs,
  AgentSessionMeta,
  AgentTab,
} from "@/commands/services/agent-chat/types";
import type { AgentChatErrorView, AgentTabState } from "../types";

export interface AgentChatStore {
  // data
  engines: AgentEngineInfo[];
  sessions: AgentSessionMeta[];
  sessionsLoading: boolean;
  tabs: AgentTab[];
  activeTabId: string | null;
  byTab: Record<string, AgentTabState>;
  drafts: Record<string, string>;
  grants: Record<string, string[]>;
  enginePrefs: Record<string, AgentEnginePrefs>;
  uiReady: boolean;
  uiError: AgentChatErrorView | null;
  // actions
  init(): Promise<void>;
  refreshEngines(): Promise<void>;
  refreshSessions(): Promise<void>;
  openSession(engine: string, sessionId: string, workspacePath: string): Promise<void>;
  newTab(engine: string, workspacePath: string): void;
  closeTab(tabId: string): Promise<void>;
  focusTab(tabId: string): void;
  setDraft(tabId: string, text: string): void;
  setModel(engine: string, model: string): Promise<void>;
  setEffort(engine: string, effort: string): Promise<void>;
  setPermission(engine: string, permission: string): Promise<void>;
  setWorkspace(tabId: string, workspacePath: string): void;
  send(tabId: string, prompt: string): Promise<void>;
  interrupt(tabId: string): Promise<void>;
  answerQuestion(tabId: string, requestId: string, answers: AgentAnswerMap | null): Promise<void>;
  grantAndRetry(tabId: string, rowSeq: number, dir: string): Promise<void>;
  dismissGrant(tabId: string, rowSeq: number): void;
  loadEarlier(tabId: string): Promise<void>;
}
