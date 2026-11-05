import { navigateApp } from "@/lib/router";

/**
 * The Git feature's picker: "open a repository / recent repositories". It is a
 * page of the main window like every other sidebar entry, so it carries no
 * repository of its own — picking one there opens that repository's window.
 */
export const GIT_REPO_HOME_PATH = "/git-repo";

/**
 * One repository's window. `main.tsx` routes on `pathname` alone and decides
 * shell-or-window from the same string, so the repository window cannot share
 * the picker's route: it needs a pathname of its own to stay out of the app
 * shell. Which repository it shows travels in the query.
 */
export const GIT_REPO_WINDOW_PATH = "/git-repo-window";

/**
 * The picker lives in the main window, but "go home" is asked for from inside a
 * repository window, which cannot navigate another window. The repository
 * window announces the intent and the main window — the one that owns the route
 * — acts on it.
 */
export const GIT_HOME_EVENT = "git-show-home";

export function openGitRepoHome(): void {
  navigateApp(GIT_REPO_HOME_PATH);
}
