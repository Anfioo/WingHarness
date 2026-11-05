import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { credentialPrefsSet } from "@/commands";
import { gitStateStorage } from "../persist-storage";

export interface IdentityProfile {
  id: string;
  label: string;
  name: string;
  email: string;
  accounts?: Record<string, string>;
}

interface IdentityState {
  sshKeyPath: string;
  sshUseAgent: boolean;
  useCredentialHelper: boolean;
  profiles: IdentityProfile[];
  setSshKeyPath: (path: string) => void;
  setSshUseAgent: (use: boolean) => void;
  setUseCredentialHelper: (use: boolean) => void;
  addProfile: (profile: Omit<IdentityProfile, "id">) => IdentityProfile;
  updateProfile: (id: string, patch: Partial<Omit<IdentityProfile, "id">>) => void;
  removeProfile: (id: string) => void;
}

function syncPrefs(
  state: Pick<IdentityState, "sshKeyPath" | "sshUseAgent" | "useCredentialHelper">
) {
  const keyPath = state.sshKeyPath.trim();
  void credentialPrefsSet(keyPath || null, state.sshUseAgent, state.useCredentialHelper).catch(
    () => {}
  );
}

export const useIdentity = create<IdentityState>()(
  persist(
    (set, get) => ({
      sshKeyPath: "",
      sshUseAgent: true,
      useCredentialHelper: true,
      profiles: [],
      setSshKeyPath: (path) => {
        set({ sshKeyPath: path });
        syncPrefs(get());
      },
      setSshUseAgent: (use) => {
        set({ sshUseAgent: use });
        syncPrefs(get());
      },
      setUseCredentialHelper: (use) => {
        set({ useCredentialHelper: use });
        syncPrefs(get());
      },
      addProfile: (profile) => {
        const created: IdentityProfile = { ...profile, id: crypto.randomUUID() };
        set((state) => ({ profiles: [...state.profiles, created] }));
        return created;
      },
      updateProfile: (id, patch) =>
        set((state) => ({
          profiles: state.profiles.map((profile) =>
            profile.id === id ? { ...profile, ...patch } : profile
          ),
        })),
      removeProfile: (id) =>
        set((state) => ({ profiles: state.profiles.filter((profile) => profile.id !== id) })),
    }),
    { name: "git-identity", storage: createJSONStorage(() => gitStateStorage) }
  )
);
