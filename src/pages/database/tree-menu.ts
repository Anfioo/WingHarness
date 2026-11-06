// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Context menu of an object tree node. It is data, not JSX: the tree renders
 * it with the shadcn context menu. Items that do not apply to a node are
 * returned disabled rather than left out, so the menu keeps a stable shape.
 *
 * The SQL Scripts entries share the `script.` id prefix; the renderer collects
 * them into one submenu.
 */

import type { DbDriver, RoutineInfo, TableInfo } from "@/commands";
import {
  SCRIPT_LABELS,
  canDrop,
  canModifyTable,
  canRename,
  type DbObjectRef,
  type ScriptKind,
} from "./object-sql";

export type TreeMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  run(): void;
};

/** The `id` prefix of the entries that make up the SQL Scripts submenu. */
export const SCRIPT_ITEM_PREFIX = "script.";

/** The part of a tree node the menu depends on. */
export type TreeMenuTarget =
  | { kind: "source"; id: string; driver: DbDriver }
  | { kind: "database"; id: string; driver: DbDriver; name: string; current: boolean }
  | { kind: "schema"; id: string; driver: DbDriver; schema: string }
  | { kind: "folder"; id: string; driver: DbDriver; schema: string }
  | { kind: "table"; id: string; driver: DbDriver; schema: string; table: TableInfo }
  | { kind: "routine"; id: string; driver: DbDriver; schema: string; routine: RoutineInfo }
  | { kind: "sequence"; id: string; driver: DbDriver; schema: string; name: string };

export type TreeMenuHandlers = {
  newTable(target: string, schema: string): void;
  rename(target: string, object: DbObjectRef): void;
  drop(target: string, object: DbObjectRef): void;
  truncate(target: string, schema: string, table: string): void;
  modify(target: string, schema: string, table: string): void;
  showDdl(target: string, schema: string, object: DbObjectRef): void;
  script(target: string, kind: ScriptKind, schema: string, table: string): void;
  refresh(): void;
};

export type Translate = (key: string) => string;

const SCRIPTS: readonly ScriptKind[] = ["selectAll", "selectFirst", "insert", "update", "delete"];

function item(
  id: string,
  label: string,
  disabled: boolean,
  run: () => void,
  destructive = false
): TreeMenuItem {
  return { id, label, disabled, destructive, run };
}

function scriptItems(
  target: string,
  schema: string,
  table: string,
  enabled: (kind: ScriptKind) => boolean,
  t: Translate,
  handlers: TreeMenuHandlers
): TreeMenuItem[] {
  return SCRIPTS.map((kind) =>
    item(`${SCRIPT_ITEM_PREFIX}${kind}`, t(SCRIPT_LABELS[kind]), !enabled(kind), () =>
      handlers.script(target, kind, schema, table)
    )
  );
}

/**
 * The menu of `node`. `t` translates the labels; the caller owns the actions.
 */
export function buildTreeMenu(
  node: TreeMenuTarget,
  t: Translate,
  handlers: TreeMenuHandlers
): TreeMenuItem[] {
  switch (node.kind) {
    case "source":
    case "database":
      return [item("refresh", t("database.object.refresh"), false, handlers.refresh)];

    case "schema":
    case "folder":
      return [
        item("newTable", t("database.object.newTable"), false, () =>
          handlers.newTable(node.id, node.schema)
        ),
        item("refresh", t("database.object.refresh"), false, handlers.refresh),
      ];

    case "table": {
      const object: DbObjectRef = {
        kind: node.table.kind,
        schema: node.schema,
        name: node.table.name,
      };
      const view = node.table.kind !== "table";
      return [
        item("newTable", t("database.object.newTable"), false, () =>
          handlers.newTable(node.id, node.schema)
        ),
        item("rename", t("database.object.rename"), !canRename(node.driver, object), () =>
          handlers.rename(node.id, object)
        ),
        item("modify", t("database.object.modify"), view || !canModifyTable(node.driver), () =>
          handlers.modify(node.id, node.schema, node.table.name)
        ),
        item("truncate", t("database.object.truncate"), view, () =>
          handlers.truncate(node.id, node.schema, node.table.name)
        ),
        item(
          "drop",
          t("database.object.drop"),
          !canDrop(node.driver, object),
          () => handlers.drop(node.id, object),
          true
        ),
        item("ddl", t("database.object.ddl"), false, () =>
          handlers.showDdl(node.id, node.schema, object)
        ),
        ...scriptItems(
          node.id,
          node.schema,
          node.table.name,
          (kind) => (!view ? true : kind === "selectAll"),
          t,
          handlers
        ),
        item("refresh", t("database.object.refresh"), false, handlers.refresh),
      ];
    }

    case "routine": {
      const object: DbObjectRef = {
        kind: node.routine.kind,
        schema: node.schema,
        name: node.routine.name,
        arguments: node.routine.arguments,
      };
      return [
        item("ddl", t("database.object.ddl"), false, () =>
          handlers.showDdl(node.id, node.schema, object)
        ),
        item(
          "drop",
          t("database.object.drop"),
          !canDrop(node.driver, object),
          () => handlers.drop(node.id, object),
          true
        ),
        item("refresh", t("database.object.refresh"), false, handlers.refresh),
      ];
    }

    case "sequence": {
      const object: DbObjectRef = { kind: "sequence", schema: node.schema, name: node.name };
      return [
        item("ddl", t("database.object.ddl"), false, () =>
          handlers.showDdl(node.id, node.schema, object)
        ),
        item(
          "drop",
          t("database.object.drop"),
          !canDrop(node.driver, object),
          () => handlers.drop(node.id, object),
          true
        ),
        item("refresh", t("database.object.refresh"), false, handlers.refresh),
      ];
    }
  }
}
