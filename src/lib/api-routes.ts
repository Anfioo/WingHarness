import { navigateApp } from "@/lib/router";

/**
 * The API client's picker: the workspace list ("open a workspace / recent
 * workspaces"). It is a page of the main window like every other sidebar entry,
 * so it carries no workspace of its own — picking one there opens that
 * workspace's window.
 */
export const API_CLIENT_HOME_PATH = "/api-client";

/**
 * One workspace's window. `main.tsx` routes on `pathname` alone and decides
 * shell-or-window from the same string, so the workspace window cannot share
 * the picker's route: it needs a pathname of its own to stay out of the app
 * shell. Which workspace it shows travels in the query.
 */
export const API_CLIENT_WINDOW_PATH = "/api-client-window";

/**
 * The picker lives in the main window, but "go home" is asked for from inside a
 * workspace window, which cannot navigate another window. The workspace window
 * announces the intent and the main window — the one that owns the route —
 * acts on it.
 */
export const API_HOME_EVENT = "api-show-home";

export function openApiClientHome(): void {
  navigateApp(API_CLIENT_HOME_PATH);
}
