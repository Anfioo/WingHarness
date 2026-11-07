// The Agent chat store.
//
// One zustand store owns the engine list, the native session list, the open
// tabs and each tab's run state. `byTab` is keyed by the locally generated
// `tabId`: a new conversation has no session id until the engine reports one,
// and the tab must survive that transition without unmounting.

import { toast } from "sonner";
import { create } from "zustand";

import { getConfig } from "@/commands";
import {
  agentAnswer,
  agentInterrupt,
  agentListEngines,
  agentListSessions,
  agentLoadSession,
  agentSend,
} from "@/commands/services/agent-chat";
import type {
  AgentAnswerMap,
  AgentChatErrorCode,
  AgentEnginePrefs,
  AgentSessionMeta,
  AgentTab,
  AgentUiState,
} from "@/commands/services/agent-chat/types";
import { isAgentChatError } from "@/commands/services/agent-chat/types";
import i18n from "@/i18n";
import { initialTabState, type AgentChatErrorView, type AgentTabState } from "./types";
import { defaultUiState, flushAgentUiSave, loadUiState, saveUiState } from "./store/persistence";
import { appendUser, rowsFromMessages } from "./store/stream";
import { startAgentEventStream } from "./event-stream";
import type { AgentChatStore } from "./store/types";

/** Frontend tab limit; the backend also caps concurrent runs separately. */
export const AGENT_MAX_TABS = 8;
const SESSION_PAGE_SIZE = 200;
const SESSION_REFRESH_DELAY_MS = 500;

let initRequest: Promise<void> | null = null;
let sessionsRequest: Promise<void> | null = null;
let streamStarted = false;

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

function messageForErrorCode(code: AgentChatErrorCode): string {
  switch (code) {
    case "engine-unavailable":
      return i18n.t("agentChat.error.engineUnavailable");
    case "conflict":
      return i18n.t("agentChat.error.conflict");
    case "not-running":
      return i18n.t("agentChat.error.notRunning");
    default:
      return i18n.t("agentChat.error.send");
  }
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

function emptyPrefs(current: AgentEnginePrefs | undefined): AgentEnginePrefs {
  return {
    model: current?.model ?? null,
    effort: current?.effort ?? null,
    permission: current?.permission ?? null,
  };
}

/** The persisted projection of the live store. */
function toUiState(store: AgentChatStore): AgentUiState {
  const active = store.tabs.find((tab) => tab.tabId === store.activeTabId);
  const recent: string[] = [];
  for (const path of [active?.workspacePath, ...store.tabs.map((tab) => tab.workspacePath)]) {
    if (path && !recent.includes(path)) recent.push(path);
  }
  return {
    version: 1,
    openTabs: store.tabs,
    activeTabId: store.activeTabId,
    lastEngine: active?.engine ?? store.tabs[0]?.engine ?? "claude",
    engines: store.enginePrefs,
    grants: store.grants,
    recentWorkspaces: recent.slice(0, 10),
  };
}

function persist(): void {
  saveUiState(toUiState(useAgentChatStore.getState()));
}

/** Workspace for a brand-new tab: the configured project root. */
export async function resolveDefaultWorkspace(): Promise<string> {
  try {
    const view = await getConfig();
    return view.config.projectRoot || ".";
  } catch (error) {
    console.warn("agent-chat: failed to read projectRoot", error);
    return ".";
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
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
    if (initRequest) return initRequest;

    const run = (async () => {
      let ui = defaultUiState();
      try {
        ui = await loadUiState();
      } catch (error) {
        set({ uiError: toAgentChatErrorView(error) });
      }
      set({ enginePrefs: ui.engines, grants: ui.grants });

      await Promise.all([get().refreshEngines(), get().refreshSessions()]);

      const restored = await Promise.all(
        ui.openTabs.slice(0, AGENT_MAX_TABS).map(async (tab) => {
          if (!tab.sessionId) return { tab, tabState: initialTabState() };
          try {
            const page = await agentLoadSession(
              tab.engine,
              tab.sessionId,
              tab.workspacePath,
              SESSION_PAGE_SIZE,
              null
            );
            return {
              tab,
              tabState: {
                ...initialTabState(),
                messages: rowsFromMessages(page.messages),
                nextBefore: page.nextBefore,
              },
            };
          } catch (error) {
            console.warn("agent-chat: failed to restore tab", tab.tabId, error);
            return null;
          }
        })
      );

      const tabs: AgentTab[] = [];
      const byTab: Record<string, AgentTabState> = {};
      for (const entry of restored) {
        if (!entry) continue;
        tabs.push(entry.tab);
        byTab[entry.tab.tabId] = entry.tabState;
      }

      let activeTabId =
        ui.activeTabId && tabs.some((tab) => tab.tabId === ui.activeTabId)
          ? ui.activeTabId
          : (tabs[0]?.tabId ?? null);

      if (tabs.length === 0) {
        const tab: AgentTab = {
          tabId: makeTabId(),
          engine: ui.lastEngine || "claude",
          sessionId: null,
          workspacePath: await resolveDefaultWorkspace(),
        };
        tabs.push(tab);
        byTab[tab.tabId] = initialTabState();
        activeTabId = tab.tabId;
      }

      set({
        tabs,
        byTab,
        activeTabId,
        drafts: Object.fromEntries(tabs.map((tab) => [tab.tabId, ""])),
        uiReady: true,
      });
      persist();

      if (!streamStarted) {
        streamStarted = true;
        void startAgentEventStream().catch((error: unknown) => {
          console.warn("agent-chat: failed to subscribe to agent:event", error);
        });
      }
    })();

    initRequest = run;
    try {
      await run;
    } catch (error) {
      console.warn("agent-chat: initialisation failed", error);
      set({ uiReady: true, uiError: toAgentChatErrorView(error) });
    } finally {
      if (initRequest === run) initRequest = null;
    }
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
    if (sessionsRequest) return sessionsRequest;

    const run = (async () => {
      set({ sessionsLoading: true });
      try {
        const sessions = await agentListSessions(null, null, SESSION_PAGE_SIZE);
        sessions.sort((left, right) => sessionTime(right) - sessionTime(left));
        set({ sessions, sessionsLoading: false });
      } catch (error) {
        console.warn("agent-chat: failed to list native sessions", error);
        set({ sessionsLoading: false, uiError: toAgentChatErrorView(error) });
      }
    })();

    sessionsRequest = run;
    try {
      await run;
    } finally {
      if (sessionsRequest === run) sessionsRequest = null;
    }
  },

  async openSession(engine: string, sessionId: string, workspacePath: string) {
    const existing = get().tabs.find(
      (tab) =>
        tab.engine === engine && tab.sessionId === sessionId && tab.workspacePath === workspacePath
    );
    if (existing) {
      get().focusTab(existing.tabId);
      return;
    }
    if (get().tabs.length >= AGENT_MAX_TABS) {
      toast.error(i18n.t("agentChat.tab.limit", { count: AGENT_MAX_TABS }));
      return;
    }

    const tabId = makeTabId();
    const tab: AgentTab = { tabId, engine, sessionId, workspacePath };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tabId,
      byTab: { ...state.byTab, [tabId]: { ...initialTabState(), loading: true } },
      drafts: { ...state.drafts, [tabId]: "" },
    }));
    persist();

    try {
      const page = await agentLoadSession(
        engine,
        sessionId,
        workspacePath,
        SESSION_PAGE_SIZE,
        null
      );
      set((state) => {
        const current = state.byTab[tabId];
        if (!current) return state;
        return {
          byTab: {
            ...state.byTab,
            [tabId]: {
              ...current,
              messages: rowsFromMessages(page.messages),
              nextBefore: page.nextBefore,
              loading: false,
            },
          },
        };
      });
    } catch (error) {
      console.warn("agent-chat: failed to load session", sessionId, error);
      set((state) => {
        const index = state.tabs.findIndex((candidate) => candidate.tabId === tabId);
        const remaining = state.tabs.filter((candidate) => candidate.tabId !== tabId);
        let activeTabId = state.activeTabId;
        if (state.activeTabId === tabId) {
          activeTabId = remaining[index - 1]?.tabId ?? remaining[index]?.tabId ?? null;
        }
        return {
          tabs: remaining,
          activeTabId,
          byTab: withoutKey(state.byTab, tabId),
          drafts: withoutKey(state.drafts, tabId),
        };
      });
      persist();
      toast.error(i18n.t("agentChat.error.load"));
    }
  },

  newTab(engine: string, workspacePath: string) {
    if (get().tabs.length >= AGENT_MAX_TABS) {
      toast.error(i18n.t("agentChat.tab.limit", { count: AGENT_MAX_TABS }));
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
    const before = get();
    const tab = before.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) return;

    const tabState = before.byTab[tabId];
    if (tabState?.runId) {
      try {
        await agentInterrupt(tabState.runId);
      } catch (error) {
        console.warn("agent-chat: failed to interrupt before close", tabState.runId, error);
      }
    } else if (tabState?.status === "launching") {
      console.warn("agent-chat: closing a tab whose run id has not arrived yet", tabId);
    }

    const state = get();
    const index = state.tabs.findIndex((candidate) => candidate.tabId === tabId);
    if (index === -1) return;

    const tabs = state.tabs.filter((candidate) => candidate.tabId !== tabId);
    let activeTabId = state.activeTabId;
    if (state.activeTabId === tabId) {
      activeTabId = tabs[index - 1]?.tabId ?? tabs[index]?.tabId ?? null;
    }
    set({
      tabs,
      activeTabId,
      byTab: withoutKey(state.byTab, tabId),
      drafts: withoutKey(state.drafts, tabId),
    });
    persist();
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
    set((state) => ({
      enginePrefs: {
        ...state.enginePrefs,
        [engine]: { ...emptyPrefs(state.enginePrefs[engine]), model },
      },
    }));
    persist();
  },

  async setEffort(engine: string, effort: string) {
    set((state) => ({
      enginePrefs: {
        ...state.enginePrefs,
        [engine]: { ...emptyPrefs(state.enginePrefs[engine]), effort },
      },
    }));
    persist();
  },

  async setPermission(engine: string, permission: string) {
    set((state) => ({
      enginePrefs: {
        ...state.enginePrefs,
        [engine]: { ...emptyPrefs(state.enginePrefs[engine]), permission },
      },
    }));
    persist();
  },

  setWorkspace(tabId: string, workspacePath: string) {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) return;

    const path = workspacePath.trim();
    if (!path || path === tab.workspacePath) return;
    if ((state.byTab[tabId]?.messages.length ?? 0) > 0) {
      get().newTab(tab.engine, path);
      return;
    }
    set((current) => ({
      tabs: current.tabs.map((candidate) =>
        candidate.tabId === tabId ? { ...candidate, workspacePath: path } : candidate
      ),
    }));
    persist();
  },

  async send(tabId: string, prompt: string) {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
    const tabState = state.byTab[tabId];
    if (!tab || !tabState) return;

    const text = prompt.trim();
    if (!text) {
      toast.error(i18n.t("agentChat.composer.emptyPrompt"));
      return;
    }
    if (tabState.runId || tabState.status === "launching") {
      toast.error(i18n.t("agentChat.error.conflict"));
      return;
    }

    const prefs = state.enginePrefs[tab.engine];
    set((current) => {
      const existing = current.byTab[tabId];
      if (!existing) return current;
      return {
        byTab: {
          ...current.byTab,
          [tabId]: {
            ...existing,
            messages: appendUser(existing.messages, text, new Date().toISOString()),
            status: "launching",
            error: null,
          },
        },
      };
    });

    try {
      const result = await agentSend({
        engine: tab.engine,
        workspacePath: tab.workspacePath,
        sessionId: tab.sessionId,
        prompt: text,
        model: prefs?.model ?? null,
        effort: prefs?.effort ?? null,
        permission: prefs?.permission ?? null,
        additionalDirs: state.grants[tab.workspacePath] ?? null,
        runId: null,
      });

      set((current) => {
        const existing = current.byTab[tabId];
        if (!existing) return current;
        return {
          byTab: {
            ...current.byTab,
            [tabId]: { ...existing, runId: result.runId, status: "streaming" },
          },
          tabs: result.sessionId
            ? current.tabs.map((candidate) =>
                candidate.tabId === tabId
                  ? { ...candidate, sessionId: result.sessionId }
                  : candidate
              )
            : current.tabs,
        };
      });
      if (result.sessionId) persist();

      window.setTimeout(() => {
        void get().refreshSessions();
      }, SESSION_REFRESH_DELAY_MS);
    } catch (error) {
      const view = toAgentChatErrorView(error);
      set((current) => {
        const existing = current.byTab[tabId];
        if (!existing) return current;
        return {
          byTab: {
            ...current.byTab,
            [tabId]: { ...existing, status: "error", error: view },
          },
        };
      });
      toast.error(messageForErrorCode(view.code));
    }
  },

  async interrupt(tabId: string) {
    const runId = get().byTab[tabId]?.runId;
    if (!runId) return;
    try {
      await agentInterrupt(runId);
    } catch (error) {
      console.warn("agent-chat: failed to interrupt", runId, error);
      toast.error(i18n.t("agentChat.error.interrupt"));
    }
  },

  async answerQuestion(tabId: string, requestId: string, answers: AgentAnswerMap | null) {
    const runId = get().byTab[tabId]?.runId;
    if (!runId) {
      toast.error(i18n.t("agentChat.error.notRunning"));
      return;
    }
    try {
      await agentAnswer(runId, requestId, answers);
      patchTab(tabId, (current) => ({
        ...current,
        messages: current.messages.map((row) =>
          row.kind === "question" && row.requestId === requestId
            ? { ...row, status: "answered" }
            : row
        ),
      }));
    } catch (error) {
      console.warn("agent-chat: failed to answer question", requestId, error);
      toast.error(i18n.t("agentChat.error.answer"));
    }
  },

  async grantAndRetry(tabId: string, rowSeq: number, dir: string) {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
    const tabState = state.byTab[tabId];
    if (!tab || !tabState) return;

    const granted = dir.trim();
    if (!granted) return;
    const existing = state.grants[tab.workspacePath] ?? [];
    if (!existing.includes(granted)) {
      set({ grants: { ...state.grants, [tab.workspacePath]: [...existing, granted] } });
      persist();
    }

    patchTab(tabId, (current) => ({
      ...current,
      messages: current.messages.map((row) =>
        row.kind === "grant" && row.seq === rowSeq ? { ...row, status: "granted" } : row
      ),
    }));

    const lastUser = [...tabState.messages].reverse().find((row) => row.kind === "user");
    if (lastUser) await get().send(tabId, lastUser.text);
  },

  dismissGrant(tabId: string, rowSeq: number) {
    patchTab(tabId, (current) => ({
      ...current,
      messages: current.messages.map((row) =>
        row.kind === "grant" && row.seq === rowSeq ? { ...row, status: "dismissed" } : row
      ),
    }));
  },

  async loadEarlier(tabId: string) {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
    const tabState = state.byTab[tabId];
    if (!tab?.sessionId || !tabState || tabState.loading || tabState.nextBefore == null) return;

    set((current) => {
      const existing = current.byTab[tabId];
      if (!existing) return current;
      return { byTab: { ...current.byTab, [tabId]: { ...existing, loading: true } } };
    });

    try {
      const page = await agentLoadSession(
        tab.engine,
        tab.sessionId,
        tab.workspacePath,
        SESSION_PAGE_SIZE,
        tabState.nextBefore
      );
      const older = rowsFromMessages(page.messages);
      set((current) => {
        const existing = current.byTab[tabId];
        if (!existing) return current;
        const seen = new Set(existing.messages.map((row) => row.seq));
        const fresh = older.filter((row) => !seen.has(row.seq));
        return {
          byTab: {
            ...current.byTab,
            [tabId]: {
              ...existing,
              messages: [...fresh, ...existing.messages],
              nextBefore: page.nextBefore,
              loading: false,
            },
          },
        };
      });
    } catch (error) {
      console.warn("agent-chat: failed to load earlier messages", tabId, error);
      toast.error(i18n.t("agentChat.history.loadFailed"));
      patchTab(tabId, (current) => ({ ...current, loading: false }));
    }
  },
}));

/** Resolves the tab currently owning `runId`; events are routed with it. */
export function findTabIdByRunId(runId: string): string | null {
  const { byTab } = useAgentChatStore.getState();
  for (const [tabId, tab] of Object.entries(byTab)) {
    if (tab.runId === runId) return tabId;
  }
  return null;
}

/** Immutable single-tab patch for the event stream and external callers. */
export function patchTab(tabId: string, updater: (tab: AgentTabState) => AgentTabState): void {
  useAgentChatStore.setState((state) => {
    const current = state.byTab[tabId];
    if (!current) return state;
    const next = updater(current);
    if (next === current) return state;
    return { byTab: { ...state.byTab, [tabId]: next } };
  });
}

/** Writes a late session id back onto the tab that owns `runId`. */
export function noteRunSession(runId: string, sessionId: string): void {
  const tabId = findTabIdByRunId(runId);
  if (!tabId) return;
  useAgentChatStore.setState((state) => ({
    tabs: state.tabs.map((tab) => (tab.tabId === tabId ? { ...tab, sessionId } : tab)),
  }));
  persist();
}

// Flush the debounced write when the page reloads, so a refresh does not lose
// the most recent tab change.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushAgentUiSave);
}
