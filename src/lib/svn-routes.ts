import { navigateApp } from "@/lib/router";

/**
 * The SVN feature's picker: "open a working copy / recent working copies". It is
 * a page of the main window like every other sidebar entry, so it carries no
 * working copy of its own — picking one there opens that copy's window.
 */
export const SVN_HOME_PATH = "/svn-workspace";

/**
 * One working copy's window. `main.tsx` routes on `pathname` alone and decides
 * shell-or-window from the same string, so the working-copy window cannot share
 * the picker's route: it needs a pathname of its own to stay out of the app
 * shell. Which working copy it shows travels in the query.
 */
export const SVN_WINDOW_PATH = "/svn-workspace-window";

/**
 * One changed file's diff, in a window of its own. Opening a diff from the log
 * detail dialog used to hand it to the working-copy window's own diff panel,
 * which took the log — page, filters, scroll position — off screen with no way
 * back to it. A window of its own leaves the log exactly as it was. Which
 * working copy and which diff target travel in the query, as they do for the
 * working-copy window.
 */
export const SVN_DIFF_WINDOW_PATH = "/svn-workspace-diff";

/**
 * The picker lives in the main window, but "go home" is asked for from inside a
 * working-copy window, which cannot navigate another window. The working-copy
 * window announces the intent and the main window — the one that owns the route
 * — acts on it.
 */
export const SVN_HOME_EVENT = "svn-show-home";

export function openSvnHome(): void {
  navigateApp(SVN_HOME_PATH);
}
