import { create } from "zustand";

export interface ReviewResult {
  stagedSignature: string;
  patchHash: string;
  text: string;
}

export type FileAiKind = "explain" | "review";

export interface FileAiResult {
  kind: FileAiKind;
  patchHash: string;
  text: string;
}

export interface FileAiTarget {
  path: string;
  oid?: string;
  staged?: boolean;
}

export function explainKeyFor(repoPath: string, oid: string): string {
  return `${repoPath}\n${oid}`;
}

export function commitReviewKeyFor(repoPath: string, oid: string): string {
  return `${repoPath}\n${oid}\nreview`;
}

export function fileAiKeyFor(repoPath: string, target: FileAiTarget): string {
  return `${repoPath}\n${target.oid ?? (target.staged ? "staged" : "unstaged")}\n${target.path}`;
}

interface AiWorkState {
  reviews: Record<string, ReviewResult>;
  reviewRuns: Record<string, number>;
  reviewBusy: Record<string, boolean>;
  explains: Record<string, string>;
  explainRuns: Record<string, number>;
  explainBusy: Record<string, boolean>;
  fileAi: Record<string, FileAiResult>;
  fileAiRuns: Record<string, number>;
  fileAiBusy: Record<string, FileAiKind>;
  startReview: (repoPath: string) => number;
  isReviewRun: (repoPath: string, run: number) => boolean;
  endReview: (repoPath: string, run: number) => void;
  stopReview: (repoPath: string) => void;
  setReview: (repoPath: string, result: ReviewResult | null) => void;
  startExplain: (key: string) => number;
  isExplainRun: (key: string, run: number) => boolean;
  endExplain: (key: string, run: number) => void;
  stopExplain: (key: string) => void;
  setExplain: (key: string, text: string | null) => void;
  startFileAi: (key: string, kind: FileAiKind) => number;
  isFileAiRun: (key: string, run: number) => boolean;
  endFileAi: (key: string, run: number) => void;
  stopFileAi: (key: string) => void;
  setFileAi: (key: string, result: FileAiResult | null) => void;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export const useAiWork = create<AiWorkState>()((set, get) => ({
  reviews: {},
  reviewRuns: {},
  reviewBusy: {},
  explains: {},
  explainRuns: {},
  explainBusy: {},
  fileAi: {},
  fileAiRuns: {},
  fileAiBusy: {},

  startReview: (repoPath) => {
    const run = (get().reviewRuns[repoPath] ?? 0) + 1;
    set((state) => ({
      reviewRuns: { ...state.reviewRuns, [repoPath]: run },
      reviewBusy: { ...state.reviewBusy, [repoPath]: true },
    }));
    return run;
  },
  isReviewRun: (repoPath, run) => (get().reviewRuns[repoPath] ?? 0) === run,
  endReview: (repoPath, run) => {
    if ((get().reviewRuns[repoPath] ?? 0) !== run) return;
    set((state) => ({ reviewBusy: { ...state.reviewBusy, [repoPath]: false } }));
  },
  stopReview: (repoPath) => {
    const run = (get().reviewRuns[repoPath] ?? 0) + 1;
    set((state) => ({
      reviewRuns: { ...state.reviewRuns, [repoPath]: run },
      reviewBusy: { ...state.reviewBusy, [repoPath]: false },
    }));
  },
  setReview: (repoPath, result) =>
    set((state) => ({
      reviews: result
        ? { ...state.reviews, [repoPath]: result }
        : withoutKey(state.reviews, repoPath),
    })),

  startExplain: (key) => {
    const run = (get().explainRuns[key] ?? 0) + 1;
    set((state) => ({
      explainRuns: { ...state.explainRuns, [key]: run },
      explainBusy: { ...state.explainBusy, [key]: true },
    }));
    return run;
  },
  isExplainRun: (key, run) => (get().explainRuns[key] ?? 0) === run,
  endExplain: (key, run) => {
    if ((get().explainRuns[key] ?? 0) !== run) return;
    set((state) => ({ explainBusy: { ...state.explainBusy, [key]: false } }));
  },
  stopExplain: (key) => {
    const run = (get().explainRuns[key] ?? 0) + 1;
    set((state) => ({
      explainRuns: { ...state.explainRuns, [key]: run },
      explainBusy: { ...state.explainBusy, [key]: false },
    }));
  },
  setExplain: (key, text) =>
    set((state) => ({
      explains:
        text === null ? withoutKey(state.explains, key) : { ...state.explains, [key]: text },
    })),

  startFileAi: (key, kind) => {
    const run = (get().fileAiRuns[key] ?? 0) + 1;
    set((state) => ({
      fileAiRuns: { ...state.fileAiRuns, [key]: run },
      fileAiBusy: { ...state.fileAiBusy, [key]: kind },
    }));
    return run;
  },
  isFileAiRun: (key, run) => (get().fileAiRuns[key] ?? 0) === run,
  endFileAi: (key, run) => {
    if ((get().fileAiRuns[key] ?? 0) !== run) return;
    set((state) => ({ fileAiBusy: withoutKey(state.fileAiBusy, key) }));
  },
  stopFileAi: (key) => {
    const run = (get().fileAiRuns[key] ?? 0) + 1;
    set((state) => ({
      fileAiRuns: { ...state.fileAiRuns, [key]: run },
      fileAiBusy: withoutKey(state.fileAiBusy, key),
    }));
  },
  setFileAi: (key, result) =>
    set((state) => ({
      fileAi: result ? { ...state.fileAi, [key]: result } : withoutKey(state.fileAi, key),
    })),
}));
