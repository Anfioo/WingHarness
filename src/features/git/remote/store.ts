import { create } from "zustand";

export interface RemoteEditDraft {
  original: string | null;
  name: string;
  url: string;
}

interface RemoteUiState {
  editRemote: RemoteEditDraft | null;
  openEditRemote: (draft: RemoteEditDraft) => void;
  closeEditRemote: () => void;
  updateEditRemote: (patch: Partial<RemoteEditDraft>) => void;
}

export const useRemoteUi = create<RemoteUiState>((set) => ({
  editRemote: null,
  openEditRemote: (draft) => set({ editRemote: draft }),
  closeEditRemote: () => set({ editRemote: null }),
  updateEditRemote: (patch) =>
    set((state) => (state.editRemote ? { editRemote: { ...state.editRemote, ...patch } } : {})),
}));
