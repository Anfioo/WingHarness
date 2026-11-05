import { create } from "zustand";
import { gitCliVersion } from "@/commands";

export interface GitConsoleEntry {
  id: number;
  /** Wall-clock time the command finished. */
  at: number;
  /** Working copy the command ran in, or null for one that needs no repository. */
  repo: string | null;
  command: string;
  output: string;
  failed: boolean;
  durationMs: number;
}

/** How many entries the console keeps; older ones fall off the top. */
const LIMIT = 400;

let nextId = 1;

interface GitConsoleState {
  entries: GitConsoleEntry[];
  clear: () => void;
}

export const useGitConsole = create<GitConsoleState>((set) => ({
  entries: [],
  clear: () => set({ entries: [] }),
}));

function push(entry: Omit<GitConsoleEntry, "id" | "at">): void {
  useGitConsole.setState((state) => ({
    entries: [...state.entries, { ...entry, id: nextId++, at: Date.now() }].slice(-LIMIT),
  }));
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Runs a Git read and records it the way the IDE's console does.
 *
 * Repositories are read through libgit2, so there is no child process to
 * capture: the line is the git command the same call stands for, and the
 * output line is what came back. Rethrows, so callers keep their own errors.
 */
export async function trackGit<T>(
  repo: string | null,
  command: string,
  run: () => Promise<T>,
  summarize?: (value: T) => string
): Promise<T> {
  const started = performance.now();
  try {
    const value = await run();
    push({
      repo,
      command,
      output: summarize?.(value) ?? "",
      failed: false,
      durationMs: performance.now() - started,
    });
    return value;
  } catch (cause) {
    push({
      repo,
      command,
      output: describe(cause),
      failed: true,
      durationMs: performance.now() - started,
    });
    throw cause;
  }
}

let engineRequested = false;

/**
 * The console's first line: the git CLI next to the app, run for real.
 *
 * Once per session — the answer cannot change while the app is open, and a
 * console that repeats it on every visit is noise.
 */
export function ensureEngineLine(): void {
  if (engineRequested) return;
  engineRequested = true;
  const command = "git -c core.quotepath=false -c log.showSignature=false version";
  const started = performance.now();
  void gitCliVersion().then(
    (output) =>
      push({
        repo: null,
        command,
        output,
        failed: false,
        durationMs: performance.now() - started,
      }),
    (cause) =>
      push({
        repo: null,
        command,
        output: describe(cause),
        failed: true,
        durationMs: performance.now() - started,
      })
  );
}
