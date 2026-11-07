// The project every command in this webview acts on.
//
// Each window has its own JS context, so a module-level value is per-window
// state: a project window sets it to its own root once, and a picker page sets
// it whenever the user switches project. Command wrappers read it and pass it
// along as the `root` argument — no command is left guessing what "the project"
// means.

let activeRoot = "";

export function setActiveProject(root: string): void {
  activeRoot = root.trim();
}

/** The root this webview acts on; empty when none is selected. */
export function getActiveProject(): string {
  return activeRoot;
}

/** As `getActiveProject`, but for callers that cannot proceed without one. */
export function requireActiveProject(): string {
  if (!activeRoot) {
    throw new Error("No project is selected.");
  }
  return activeRoot;
}

/** Forgets the root, so a page that hides its content on change cannot keep acting on it. */
export function clearActiveProject(root?: string): void {
  if (root === undefined || root.trim() === activeRoot) {
    activeRoot = "";
  }
}
