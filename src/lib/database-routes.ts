/**
 * The database tools' picker: the data sources list. It is a page of the main
 * window like every other sidebar entry, so it carries no data source of its
 * own — picking one there opens that data source's window.
 */
export const DATABASE_HOME_PATH = "/database";

/**
 * One data source's window. `main.tsx` routes on `pathname` alone and decides
 * shell-or-window from the same string, so the data source window cannot share
 * the picker's route: it needs a pathname of its own to stay out of the app
 * shell. Which data source it shows travels in the query.
 */
export const DATABASE_WINDOW_PATH = "/database-window";
