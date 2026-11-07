// The writes the project panel makes to its own data-source list.
//
// The list lives in `<project root>/.wh/db/data-sources.toml`; every source id
// carries the `whp-` prefix the backend routes by, and a password is stored by
// `db_set_password` in the application's `secrets.json`, never in the project.
// The commands are called here rather than in the store so the store only has
// to reload the list afterwards.

import { dbProjectSourceSave, dbSourceSetPassword, newProjectSourceId } from "@/commands";
import type { DataSource, DataSourceView } from "@/commands";
import { asSource } from "@/pages/database/model";

/** The dot colours the database page uses for the same field. */
const COLOR_DOTS = {
  red: "#e5534b",
  orange: "#e8833a",
  yellow: "#e3b341",
  green: "#3fb950",
  blue: "#4c8eda",
  violet: "#a371f7",
} as const;

export function sourceColorDot(source: DataSourceView): string | undefined {
  return source.color ? COLOR_DOTS[source.color] : undefined;
}

/** Where a source points, with the credential of a URL-only source hidden. */
export function sourceSummary(source: DataSourceView): string {
  if (source.driver === "sqlite") return source.file ?? "";
  if (source.urlOnly) {
    return source.url.replace(/:\/\/([^:/@]+):[^@]*@/, "://$1:***@");
  }
  const host = source.port === null ? source.host : `${source.host}:${source.port}`;
  const database = source.database ? `/${source.database}` : "";
  return `${source.user ? `${source.user}@` : ""}${host}${database}`;
}

/** Saves the list with `source` added or replaced, then its password, if any. */
export async function saveProjectSource(
  list: DataSourceView[],
  source: DataSource,
  password: string
): Promise<void> {
  const stored = list.map(asSource);
  const exists = stored.some((entry) => entry.id === source.id);
  await dbProjectSourceSave(
    exists ? stored.map((entry) => (entry.id === source.id ? source : entry)) : [...stored, source]
  );
  if (password) await dbSourceSetPassword(source.id, password, source.savePassword);
}

/** Adds a copy under a new `whp-` id; the password is deliberately not carried over. */
export async function duplicateProjectSource(
  list: DataSourceView[],
  source: DataSourceView,
  name: string
): Promise<void> {
  const copy: DataSource = { ...asSource(source), id: newProjectSourceId(), name };
  await dbProjectSourceSave([...list.map(asSource), copy]);
}

export async function deleteProjectSource(list: DataSourceView[], sourceId: string): Promise<void> {
  await dbProjectSourceSave(list.filter((entry) => entry.id !== sourceId).map(asSource));
}
