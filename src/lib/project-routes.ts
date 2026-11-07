import { navigateApp } from "@/lib/router";

/**
 * The project picker: "open a folder / recent projects". It is the app's start
 * page, a page of the main window like every other sidebar entry, so it carries
 * no project of its own — picking one there opens that project's window.
 */
export const PROJECT_HOME_PATH = "/";

/**
 * One project's window. `main.tsx` routes on `pathname` alone and decides
 * shell-or-window from the same string, so the project window cannot share the
 * picker's route: it needs a pathname of its own to stay out of the app shell.
 * Which project it shows travels in the query.
 */
export const PROJECT_WINDOW_PATH = "/project-window";

/**
 * The picker lives in the main window, but "go home" is asked for from inside a
 * project window, which cannot navigate another window. The project window
 * announces the intent and the main window — the one that owns the route — acts
 * on it.
 */
export const PROJECT_HOME_EVENT = "project-show-home";

export function openProjectHome(): void {
  navigateApp(PROJECT_HOME_PATH);
}
