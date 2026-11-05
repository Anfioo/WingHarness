import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { aiCliDetect, aiKeyDelete, aiKeyGet, aiKeySet } from "@/commands";
import type { CliAgentInfo } from "@/commands";
import type { AiProviderKind, CliAgentId } from "@/lib/git-core/ai";
import { gitStateStorage } from "../persist-storage";

export interface AiSettings {
  provider: AiProviderKind;
  apiKey: string;
  model: string;
  baseUrl: string;
  cliAgent: CliAgentId | "";
  cliPath: string;
}

const DEFAULT_AI: AiSettings = {
  provider: "cli",
  apiKey: "",
  model: "",
  baseUrl: "",
  cliAgent: "claude",
  cliPath: "",
};

const KEY_SAVE_DEBOUNCE_MS = 400;

let keySaveTimer: number | null = null;
let pendingKey: { provider: string; apiKey: string } | null = null;

function cancelKeySave(): void {
  if (keySaveTimer !== null) window.clearTimeout(keySaveTimer);
  keySaveTimer = null;
  pendingKey = null;
}

function flushKeySave(): void {
  if (keySaveTimer !== null) {
    window.clearTimeout(keySaveTimer);
    keySaveTimer = null;
  }
  const entry = pendingKey;
  pendingKey = null;
  if (entry) void aiKeySet(entry.provider, entry.apiKey).catch(() => {});
}

/** Writing on every keystroke sent unordered keychain writes, so an earlier,
 * shorter key could be the one that survived. */
function scheduleKeySave(provider: string, apiKey: string): void {
  pendingKey = { provider, apiKey };
  if (keySaveTimer !== null) window.clearTimeout(keySaveTimer);
  keySaveTimer = window.setTimeout(flushKeySave, KEY_SAVE_DEBOUNCE_MS);
}

window.addEventListener("pagehide", flushKeySave);

interface AiState {
  ai: AiSettings;
  /** Detected CLI agents, kept between launches so detection is not redone. */
  cliAgents: CliAgentInfo[] | null;
  hydrateApiKey: () => Promise<void>;
  refreshCliAgents: () => Promise<void>;
  setProvider: (provider: AiProviderKind) => void;
  setModel: (model: string) => void;
  setBaseUrl: (baseUrl: string) => void;
  setCliAgent: (cliAgent: CliAgentId | "") => void;
  setCliPath: (cliPath: string) => void;
  setApiKey: (apiKey: string) => void;
  clearApiKey: () => void;
}

export const useAi = create<AiState>()(
  persist(
    (set, get) => ({
      ai: DEFAULT_AI,
      cliAgents: null,
      hydrateApiKey: async () => {
        const provider = get().ai.provider;
        let key: string | null = null;
        try {
          key = await aiKeyGet(provider);
        } catch {
          key = null;
        }
        // The provider or the key can change while the keychain read is in flight.
        if (get().ai.provider !== provider || get().ai.apiKey !== "") return;
        set((state) => ({ ai: { ...state.ai, apiKey: key ?? "" } }));
      },
      refreshCliAgents: async () => {
        try {
          set({ cliAgents: await aiCliDetect() });
        } catch {
          // A failed probe is not retried until the user asks for it, so a
          // broken lookup cannot slow down every visit to the settings page.
          set({ cliAgents: [] });
        }
      },
      setProvider: (provider) => {
        set((state) => ({ ai: { ...state.ai, provider, apiKey: "" } }));
        void get().hydrateApiKey();
      },
      setModel: (model) => set((state) => ({ ai: { ...state.ai, model } })),
      setBaseUrl: (baseUrl) => set((state) => ({ ai: { ...state.ai, baseUrl } })),
      setCliAgent: (cliAgent) => set((state) => ({ ai: { ...state.ai, cliAgent } })),
      setCliPath: (cliPath) => set((state) => ({ ai: { ...state.ai, cliPath } })),
      setApiKey: (apiKey) => {
        const value = apiKey.trim();
        set((state) => ({ ai: { ...state.ai, apiKey: value } }));
        scheduleKeySave(get().ai.provider, value);
      },
      clearApiKey: () => {
        set((state) => ({ ai: { ...state.ai, apiKey: "" } }));
        cancelKeySave();
        void aiKeyDelete(get().ai.provider).catch(() => {});
      },
    }),
    {
      name: "git-ai",
      storage: createJSONStorage(() => gitStateStorage),
      partialize: (state) => ({ ai: { ...state.ai, apiKey: "" }, cliAgents: state.cliAgents }),
      // The key is stripped from the persisted state, so it has to be read back
      // once the provider it belongs to has been restored.
      onRehydrateStorage: () => (state) => {
        if (state) void state.hydrateApiKey();
      },
    }
  )
);
