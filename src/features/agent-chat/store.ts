// The Agent chat store.
//
// A0 ships a working shell: bootstrap, the engine/session lists, tab
// creation/focus and drafts. Every action that needs an engine transport is a
// logged no-op until F1/F2/F3 fill it in. The export and the interface in
// `./store/types.ts` are frozen.

import { create } from "zustand";

import { agentListEngines, agentListSessions } from "@/commands/services/agent-chat";
import type {
  AgentAnswerMap,
  AgentSessionMeta,
  AgentTab,
  AgentUiState,
} from "@/commands/services/agent-chat/types";
import { isAgentChatError } from "@/commands/services/agent-chat/types";
import { initialTabState, type AgentChatErrorView, type AgentTabState } from "./types";
import { flushAgentUiSave, loadAgentUiState, scheduleAgentUiSave } from "./store/persistence";
import { startAgentEventStream } from "./event-stream";
import type { AgentChatStore } from "./store/types";

const MAX_TABS = 8;
const SESSION_PAGE_SIZE = 200;

/** Normalizes anything thrown by a command into the inline error view. */
export function toAgentChatErrorView(error: unknown): AgentChatErrorView {
  if (isAgentChatError(error)) {
    return { code: error.code, message: error.message, detail: error.detail ?? null };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : "Unknown error.",
    detail: null,
  };
}

function makeTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sessionTime(session: AgentSessionMeta): number {
  return session.updatedAt ?? session.fileMtimeMs;
}

/** The persisted projection of the live store. */
function toUiState(store: AgentChatStore): AgentUiState {
  const active = store.tabs.find((tab) => tab.tabId === store.activeTabId);
  const recent: string[] = [];
  for (const tab of store.tabs) {
    if (tab.workspacePath && !recent.includes(tab.workspacePath)) recent.push(tab.workspacePath);
  }
  return {
    version: 1,
    openTabs: store.tabs,
    activeTabId: store.activeTabId,
    lastEngine: active?.engine ?? store.tabs[0]?.engine ?? "claude",
    engines: store.enginePrefs,
    grants: store.grants,
    recentWorkspaces: recent.slice(-10),
  };
}

let streamStarted = false;

function persist(): void {
  scheduleAgentUiSave(toUiState(useAgentChatStore.getState()));
}

export const useAgentChatStore = create<AgentChatStore>()((set, get) => ({
  engines: [],
  sessions: [],
  sessionsLoading: false,
  tabs: [],
  activeTabId: null,
  byTab: {},
  drafts: {},
  grants: {},
  enginePrefs: {},
  uiReady: false,
  uiError: null,

  async init() {
    if (get().uiReady) return;
    try {
      const ui = await loadAgentUiState();
      const byTab: Record<string, AgentTabState> = {};
      for (const tab of ui.openTabs) byTab[tab.tabId] = initialTabState();
      const activeTabId =
        ui.activeTabId && ui.openTabs.some((tab) => tab.tabId === ui.activeTabId)
          ? ui.activeTabId
          : (ui.openTabs[0]?.tabId ?? null);
      set({
        tabs: ui.openTabs,
        activeTabId,
        byTab,
        enginePrefs: ui.engines,
        grants: ui.grants,
        uiReady: true,
      });
    } catch (error) {
      set({ uiReady: true, uiError: toAgentChatErrorView(error) });
    }

    if (!streamStarted) {
      streamStarted = true;
      void startAgentEventStream().catch((error: unknown) => {
        console.warn("agent-chat: failed to subscribe to agent:event", error);
      });
    }

    await Promise.all([get().refreshEngines(), get().refreshSessions()]);
  },

  async refreshEngines() {
    try {
      const engines = await agentListEngines();
      set({ engines });
    } catch (error) {
      set({ uiError: toAgentChatErrorView(error) });
    }
  },

  async refreshSessions() {
    set({ sessionsLoading: true });
    try {
      const sessions = await agentListSessions(null, null, SESSION_PAGE_SIZE);
      sessions.sort((left, right) => sessionTime(right) - sessionTime(left));
      set({ sessions, sessionsLoading: false });
    } catch (error) {
      console.warn("agent-chat: failed to list native sessions", error);
      set({ sessionsLoading: false, uiError: toAgentChatErrorView(error) });
    }
  },

  async openSession(engine: string, sessionId: string, workspacePath: string) {
    void [engine, sessionId, workspacePath];
    console.warn("agent-chat: openSession is not implemented yet.");
  },

  newTab(engine: string, workspacePath: string) {
    const { tabs } = get();
    if (tabs.length >= MAX_TABS) {
      console.warn("agent-chat: tab limit reached", MAX_TABS);
      return;
    }
    const tab: AgentTab = { tabId: makeTabId(), engine, sessionId: null, workspacePath };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.tabId,
      byTab: { ...state.byTab, [tab.tabId]: initialTabState() },
      drafts: { ...state.drafts, [tab.tabId]: "" },
    }));
    persist();
  },

  async closeTab(tabId: string) {
    void tabId;
    console.warn("agent-chat: closeTab is not implemented yet.");
  },

  focusTab(tabId: string) {
    if (!get().tabs.some((tab) => tab.tabId === tabId)) return;
    set({ activeTabId: tabId });
    persist();
  },

  setDraft(tabId: string, text: string) {
    set((state) => ({ drafts: { ...state.drafts, [tabId]: text } }));
  },

  async setModel(engine: string, model: string) {
    void [engine, model];
    console.warn("agent-chat: setModel is not implemented yet.");
  },

  async setEffort(engine: string, effort: string) {
    void [engine, effort];
    console.warn("agent-chat: setEffort is not implemented yet.");
  },

  async setPermission(engine: string, permission: string) {
    void [engine, permission];
    console.warn("agent-chat: setPermission is not implemented yet.");
  },

  setWorkspace(tabId: string, workspacePath: string) {
    void [tabId, workspacePath];
    console.warn("agent-chat: setWorkspace is not implemented yet.");
  },

  async send(tabId: string, prompt: string) {
    void [tabId, prompt];
    console.warn("agent-chat: send is not implemented yet.");
  },

  async interrupt(tabId: string) {
    void tabId;
    console.warn("agent-chat: interrupt is not implemented yet.");
  },

  async answerQuestion(tabId: string, requestId: string, answers: AgentAnswerMap | null) {
    void [tabId, requestId, answers];
    console.warn("agent-chat: answerQuestion is not implemented yet.");
  },

  async grantAndRetry(tabId: string, rowSeq: number, dir: string) {
    void [tabId, rowSeq, dir];
    console.warn("agent-chat: grantAndRetry is not implemented yet.");
  },

  dismissGrant(tabId: string, rowSeq: number) {
    void [tabId, rowSeq];
    console.warn("agent-chat: dismissGrant is not implemented yet.");
  },

  async loadEarlier(tabId: string) {
    void tabId;
    console.warn("agent-chat: loadEarlier is not implemented yet.");
  },
}));

// Flush the debounced write when the page reloads, so a refresh does not lose
// the most recent tab change.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushAgentUiSave);
}
