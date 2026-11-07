// Database commands for the project page's panel.
//
// The project panel talks to a second `DbManager` that keeps its data sources,
// query files and settings under `<project root>/.wh/db`, isolated from the
// `/database` page. The backend routes a command to it by the `whp-` prefix of
// the id it is given, so every id-taking command in `./index` works unchanged;
// only the eight commands that name their scope get a project wrapper here.

import {
  dbQueries,
  dbQueryRead,
  dbQueryWrite,
  dbSaveSettings,
  dbSettings,
  dbSourceList,
  dbSourceSave,
} from "./index";
import type { DbScope } from "./index";
import type { DataSource, DataSourceView, DbSettings, QueryFile } from "./types";

/** Every id the project panel creates starts with this. Mirrors `commands/db.rs`. */
const PROJECT_ID_PREFIX = "whp-";

/** A fresh id for a data source that belongs to the project, not to the app. */
export function newProjectSourceId(): string {
  return `${PROJECT_ID_PREFIX}${crypto.randomUUID()}`;
}

/** Whether `id` names a project data source rather than an app-wide one. */
function isProjectSourceId(id: string): boolean {
  return id.startsWith(PROJECT_ID_PREFIX);
}

/** The engine a data source id lives in, for commands that need it named. */
export function dbScopeOf(id: string): DbScope {
  return isProjectSourceId(id) ? "project" : "app";
}

/** The data sources saved under the project. */
export async function dbProjectSourceList(): Promise<DataSourceView[]> {
  return await dbSourceList("project");
}

/** Replaces the project's stored data-source list. Passwords are not in it. */
export async function dbProjectSourceSave(sources: DataSource[]): Promise<void> {
  await dbSourceSave(sources, "project");
}

/** The `.sql` files under `<project root>/.wh/db/query`. */
export async function dbProjectQueries(): Promise<QueryFile[]> {
  return await dbQueries("project");
}

export async function dbProjectQueryRead(name: string): Promise<string> {
  return await dbQueryRead(name, "project");
}

export async function dbProjectQueryWrite(name: string, text: string): Promise<void> {
  await dbQueryWrite(name, text, "project");
}

export async function dbProjectSettings(): Promise<DbSettings> {
  return await dbSettings("project");
}

export async function dbProjectSaveSettings(settings: DbSettings): Promise<void> {
  await dbSaveSettings(settings, "project");
}
