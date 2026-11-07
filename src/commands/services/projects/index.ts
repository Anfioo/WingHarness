import { invokeCommand } from "../../base";

/** One entry of the recent-projects list, newest first. */
export interface ProjectEntry {
  path: string;
  /** The directory's own name, captured when it was remembered. */
  name: string;
  /** Unix milliseconds of the last time the project was opened. */
  openedAt: number;
}

/** The store `project_remember` and friends return. */
export interface Projects {
  /** The root a page with no project of its own should default to; "" if none. */
  active: string;
  recent: ProjectEntry[];
}

export function projectRecentList(): Promise<ProjectEntry[]> {
  return invokeCommand("project_recent_list", {});
}

/** The last opened project; `null` when the list has never been written. */
export function projectActive(): Promise<string | null> {
  return invokeCommand("project_active", {});
}

/** Adds or moves the project to the top of the list, and makes it active. */
export function projectRemember(root: string): Promise<Projects> {
  return invokeCommand("project_remember", { root });
}

/** Removes the project from the list; the directory itself is untouched. */
export function projectForget(root: string): Promise<Projects> {
  return invokeCommand("project_forget", { root });
}

/** Makes a project active without touching the order of the list. */
export function projectSetActive(root: string): Promise<Projects> {
  return invokeCommand("project_set_active", { root });
}
