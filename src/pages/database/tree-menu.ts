// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Context menu of an object tree node. It is data, not JSX: the tree renders it
 * with the shadcn context menu, recursing into `children` for a submenu. Items
 * that do not apply to a node are returned disabled rather than left out, so
 * the menu keeps a stable shape.
 *
 * The entries follow IDEA's layout: New, Copy/Paste, Quick Documentation,
 * Navigation, SQL Scripts, Import/Export and Object Actions. The data-source
 * entries of the original (New Data Source, Duplicate, Remove, Import from
 * Clipboard) stay on the `/database` list page and are not offered here.
 */

import type {
  ColumnInfo,
  DbDriver,
  ForeignKey,
  IndexInfo,
  RoutineInfo,
  TableInfo,
  TriggerInfo,
} from "@/commands";
import {
  SCRIPT_LABELS,
  canDrop,
  canModifyTable,
  canRename,
  type DbObjectRef,
  type ScriptKind,
} from "./object-sql";
import type { TreeGroup } from "./tree-model";

export type TreeMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  run(): void;
  /** Present when the entry opens a submenu. */
  children?: TreeMenuItem[];
  /** Present when the entry is a separator. */
  separator?: boolean;
};

/** The folders of a schema, as the source names them. */
export type TreeFolder = "tables" | "views" | "materializedViews" | "routines" | "sequences";

/** The part of a tree node the menu depends on. */
export type TreeMenuTarget =
  | { kind: "source"; id: string; driver: DbDriver }
  | { kind: "database"; id: string; driver: DbDriver; name: string; current: boolean }
  | { kind: "schema"; id: string; driver: DbDriver; schema: string }
  | { kind: "folder"; id: string; driver: DbDriver; schema: string; folder: TreeFolder }
  | { kind: "table"; id: string; driver: DbDriver; schema: string; table: TableInfo }
  | {
      kind: "group";
      id: string;
      driver: DbDriver;
      schema: string;
      table: string;
      view: boolean;
      group: TreeGroup;
    }
  | {
      kind: "column";
      id: string;
      driver: DbDriver;
      schema: string;
      table: string;
      view: boolean;
      column: ColumnInfo;
    }
  | {
      kind: "index";
      id: string;
      driver: DbDriver;
      schema: string;
      table: string;
      view: boolean;
      index: IndexInfo;
    }
  | {
      kind: "foreignKey";
      id: string;
      driver: DbDriver;
      schema: string;
      table: string;
      view: boolean;
      foreignKey: ForeignKey;
    }
  | {
      kind: "trigger";
      id: string;
      driver: DbDriver;
      schema: string;
      table: string;
      view: boolean;
      trigger: TriggerInfo;
    }
  | { kind: "routine"; id: string; driver: DbDriver; schema: string; routine: RoutineInfo }
  | { kind: "sequence"; id: string; driver: DbDriver; schema: string; name: string };

export type TreeMenuHandlers = {
  /** Open a query tab (IDEA's Query Console). */
  newQuery(): void;
  newTable(target: string, schema: string): void;
  newColumn(target: string, schema: string, table: string): void;
  modify(target: string, schema: string, table: string): void;
  rename(target: string, object: DbObjectRef): void;
  drop(target: string, object: DbObjectRef): void;
  truncate(target: string, schema: string, table: string): void;
  refresh(target: TreeMenuTarget): void;
  disconnect(target: string): void;
  showDdl(target: TreeMenuTarget): void;
  ddlToClipboard(target: TreeMenuTarget): void;
  ddlToConsole(target: TreeMenuTarget): void;
  script(target: string, kind: ScriptKind, schema: string, table: string): void;
  copyReference(target: TreeMenuTarget): void;
  jumpToConsole(target: TreeMenuTarget): void;
  /** Absent when the window cannot show documentation; the entry is then disabled. */
  quickDoc?: (target: TreeMenuTarget) => void;
  /** Absent when the window cannot open a data tab; the entry is then disabled. */
  editData?: (target: string, schema: string, table: string) => void;
  goToReferencedTable(target: TreeMenuTarget): void;
  importData(target: string, schema: string, table: string): void;
};

/** The entries of the toolbar's New dropdown. */
export type NewMenuHandlers = {
  newQuery(): void;
  openQuery(): void;
  newTable(): void;
};

export type Translate = (key: string) => string;

const SCRIPTS: readonly ScriptKind[] = ["selectAll", "selectFirst", "insert", "update", "delete"];

function entry(
  id: string,
  label: string,
  run: () => void,
  options: { disabled?: boolean; destructive?: boolean; children?: TreeMenuItem[] } = {}
): TreeMenuItem {
  return { id, label, run, ...options };
}

/** A separator; its `run` is never called. */
function separator(id: string): TreeMenuItem {
  return { id, label: "", separator: true, run: () => {} };
}

/** The schema object a node stands for (Copy Reference, Rename, Drop). */
export function objectOf(node: TreeMenuTarget): DbObjectRef | null {
  switch (node.kind) {
    case "schema":
      return { kind: "schema", schema: node.schema, name: node.schema };
    case "table":
      return { kind: node.table.kind, schema: node.schema, name: node.table.name };
    case "group":
      return { kind: "table", schema: node.schema, name: node.table };
    case "column":
      return { kind: "column", schema: node.schema, name: node.table, column: node.column.name };
    case "index":
      return { kind: "index", schema: node.schema, name: node.index.name, table: node.table };
    case "trigger":
      return { kind: "trigger", schema: node.schema, name: node.trigger.name, table: node.table };
    case "routine":
      return {
        kind: node.routine.kind,
        schema: node.schema,
        name: node.routine.name,
        arguments: node.routine.arguments,
      };
    case "sequence":
      return { kind: "sequence", schema: node.schema, name: node.name };
    default:
      return null;
  }
}

/** The table a node belongs to, for the actions that act on the table itself. */
export function tableOf(
  node: TreeMenuTarget
): { target: string; schema: string; table: string; view: boolean } | null {
  switch (node.kind) {
    case "table":
      return {
        target: node.id,
        schema: node.schema,
        table: node.table.name,
        view: node.table.kind !== "table",
      };
    case "group":
    case "column":
    case "index":
    case "foreignKey":
    case "trigger":
      return { target: node.id, schema: node.schema, table: node.table, view: node.view };
    default:
      return null;
  }
}

/** The toolbar's New dropdown: a query, an existing query file, or a table. */
export function newMenu(t: Translate, handlers: NewMenuHandlers): TreeMenuItem[] {
  return [
    entry("new.query", t("database.tab.console"), handlers.newQuery),
    entry("new.openQuery", t("database.workspace.openQuery"), handlers.openQuery),
    separator("new.separator"),
    entry("new.table", t("database.tree.menu.newTable"), handlers.newTable),
  ];
}

function newEntry(t: Translate, children: TreeMenuItem[]): TreeMenuItem {
  return entry("new", t("database.tree.menu.new"), () => {}, { children });
}

function copyEntry(t: Translate, node: TreeMenuTarget, handlers: TreeMenuHandlers): TreeMenuItem {
  return entry("copyPaste", t("database.tree.menu.copyPaste"), () => {}, {
    children: [
      entry("copyReference", t("database.tree.menu.copyReference"), () =>
        handlers.copyReference(node)
      ),
    ],
  });
}

function navigationEntry(t: Translate, children: TreeMenuItem[]): TreeMenuItem {
  return entry("navigation", t("database.tree.menu.navigation"), () => {}, { children });
}

function scriptsEntry(t: Translate, children: TreeMenuItem[]): TreeMenuItem {
  return entry("sqlScripts", t("database.tree.menu.sqlScripts"), () => {}, { children });
}

function refreshEntry(
  t: Translate,
  node: TreeMenuTarget,
  handlers: TreeMenuHandlers
): TreeMenuItem {
  return entry("refresh", t("database.tree.menu.refresh"), () => handlers.refresh(node));
}

function quickDocEntry(
  t: Translate,
  node: TreeMenuTarget,
  handlers: TreeMenuHandlers
): TreeMenuItem {
  return entry("quickDoc", t("database.tree.menu.quickDoc"), () => handlers.quickDoc?.(node), {
    disabled: !handlers.quickDoc,
  });
}

function ddlEntries(
  t: Translate,
  node: TreeMenuTarget,
  handlers: TreeMenuHandlers
): TreeMenuItem[] {
  return [
    entry("ddlToClipboard", t("database.tree.menu.ddlToClipboard"), () =>
      handlers.ddlToClipboard(node)
    ),
    entry("ddlToConsole", t("database.tree.menu.ddlToConsole"), () => handlers.ddlToConsole(node)),
  ];
}

function dropEntry(t: Translate, node: TreeMenuTarget, handlers: TreeMenuHandlers): TreeMenuItem {
  const object = objectOf(node);
  const allowed = object ? canDrop(node.driver, object) : false;
  return entry(
    "drop",
    t("database.tree.menu.drop"),
    () => {
      if (object) handlers.drop(node.id, object);
    },
    { disabled: !allowed, destructive: true }
  );
}

function renameEntry(t: Translate, node: TreeMenuTarget, handlers: TreeMenuHandlers): TreeMenuItem {
  const object = objectOf(node);
  const allowed = object ? canRename(node.driver, object) : false;
  return entry(
    "rename",
    t("database.tree.menu.rename"),
    () => {
      if (object) handlers.rename(node.id, object);
    },
    { disabled: !allowed }
  );
}

function goToDdlEntry(
  t: Translate,
  node: TreeMenuTarget,
  handlers: TreeMenuHandlers
): TreeMenuItem {
  return entry("goToDdl", t("database.tree.menu.goToDdl"), () => handlers.showDdl(node));
}

function jumpToConsoleEntry(
  t: Translate,
  node: TreeMenuTarget,
  handlers: TreeMenuHandlers
): TreeMenuItem {
  return entry("jumpToConsole", t("database.tree.menu.jumpToConsole"), () =>
    handlers.jumpToConsole(node)
  );
}

/** The New submenu shared by the schema, folder, table and column nodes. */
function newTableEntries(
  t: Translate,
  driver: DbDriver,
  target: string,
  schema: string,
  handlers: TreeMenuHandlers,
  column: { table: string; view: boolean } | null
): TreeMenuItem[] {
  return [
    entry("new.query", t("database.tab.console"), handlers.newQuery),
    separator("new.separator"),
    ...(column
      ? [
          entry(
            "new.column",
            t("database.tree.menu.newColumn"),
            () => handlers.newColumn(target, schema, column.table),
            { disabled: column.view || !canModifyTable(driver) }
          ),
        ]
      : []),
    entry("new.table", t("database.tree.menu.newTable"), () => handlers.newTable(target, schema)),
  ];
}

function tableMenu(
  node: Extract<TreeMenuTarget, { kind: "table" | "column" }>,
  t: Translate,
  handlers: TreeMenuHandlers
): TreeMenuItem[] {
  const object = objectOf(node);
  const target = tableOf(node);
  if (!object || !target) return [];
  const view = target.view;
  const column = node.kind === "column";
  const scripts: TreeMenuItem[] = SCRIPTS.map((kind) =>
    entry(
      `script.${kind}`,
      t(SCRIPT_LABELS[kind]),
      () => handlers.script(node.id, kind, node.schema, target.table),
      { disabled: view && kind !== "selectAll" }
    )
  );

  return [
    newEntry(t, newTableEntries(t, node.driver, node.id, node.schema, handlers, target)),
    entry(
      "modify",
      column ? t("database.tree.menu.modifyColumn") : t("database.tree.menu.modifyTable"),
      () => handlers.modify(node.id, node.schema, target.table),
      { disabled: view || !canModifyTable(node.driver) }
    ),
    separator("modify.separator"),
    copyEntry(t, node, handlers),
    entry(
      "editData",
      t("database.tree.menu.editData"),
      () => handlers.editData?.(node.id, node.schema, target.table),
      {
        disabled: !handlers.editData,
      }
    ),
    refreshEntry(t, node, handlers),
    renameEntry(t, node, handlers),
    quickDocEntry(t, node, handlers),
    navigationEntry(t, [jumpToConsoleEntry(t, node, handlers), goToDdlEntry(t, node, handlers)]),
    separator("navigation.separator"),
    scriptsEntry(t, [...ddlEntries(t, node, handlers), separator("scripts.separator"), ...scripts]),
    ...(node.kind === "table" && !view
      ? [
          entry("importExport", t("database.tree.menu.importExport"), () => {}, {
            children: [
              entry("importData", t("database.tree.menu.importData"), () =>
                handlers.importData(node.id, node.schema, target.table)
              ),
            ],
          }),
          entry("objectActions", t("database.tree.menu.objectActions"), () => {}, {
            children: [
              entry("truncate", t("database.tree.menu.truncate"), () =>
                handlers.truncate(node.id, node.schema, target.table)
              ),
            ],
          }),
        ]
      : []),
    separator("drop.separator"),
    dropEntry(t, node, handlers),
  ];
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
      return [
        newEntry(t, [entry("new.query", t("database.tab.console"), handlers.newQuery)]),
        refreshEntry(t, node, handlers),
        entry("disconnect", t("database.tree.menu.disconnect"), () => handlers.disconnect(node.id)),
        copyEntry(t, node, handlers),
      ];

    case "database":
      return [
        newEntry(t, [entry("new.query", t("database.tab.console"), handlers.newQuery)]),
        copyEntry(t, node, handlers),
        refreshEntry(t, node, handlers),
        entry(
          "disconnect",
          t("database.tree.menu.disconnect"),
          () => handlers.disconnect(node.id),
          {
            disabled: node.current,
          }
        ),
      ];

    case "schema":
      return [
        newEntry(t, newTableEntries(t, node.driver, node.id, node.schema, handlers, null)),
        copyEntry(t, node, handlers),
        refreshEntry(t, node, handlers),
        separator("new.separator"),
        quickDocEntry(t, node, handlers),
        navigationEntry(t, [jumpToConsoleEntry(t, node, handlers)]),
        separator("navigation.separator"),
        scriptsEntry(t, ddlEntries(t, node, handlers)),
        separator("drop.separator"),
        dropEntry(t, node, handlers),
      ];

    case "folder":
      return [
        newEntry(t, newTableEntries(t, node.driver, node.id, node.schema, handlers, null)),
        refreshEntry(t, node, handlers),
        navigationEntry(t, [jumpToConsoleEntry(t, node, handlers)]),
        separator("navigation.separator"),
        scriptsEntry(t, ddlEntries(t, node, handlers)),
      ];

    case "table":
    case "column":
      return tableMenu(node, t, handlers);

    case "group":
      return [
        ...(node.group === "columns"
          ? [
              newEntry(t, [
                entry(
                  "new.column",
                  t("database.tree.menu.newColumn"),
                  () => handlers.newColumn(node.id, node.schema, node.table),
                  { disabled: node.view || !canModifyTable(node.driver) }
                ),
              ]),
            ]
          : []),
        refreshEntry(t, node, handlers),
        separator("navigation.separator"),
        navigationEntry(t, [goToDdlEntry(t, node, handlers)]),
      ];

    case "index":
      return [
        copyEntry(t, node, handlers),
        refreshEntry(t, node, handlers),
        separator("rename.separator"),
        renameEntry(t, node, handlers),
        separator("navigation.separator"),
        navigationEntry(t, [goToDdlEntry(t, node, handlers)]),
        separator("drop.separator"),
        dropEntry(t, node, handlers),
      ];

    case "foreignKey":
      return [
        refreshEntry(t, node, handlers),
        separator("navigation.separator"),
        navigationEntry(t, [
          entry("goToReferencedTable", t("database.tree.menu.goToReferencedTable"), () =>
            handlers.goToReferencedTable(node)
          ),
          goToDdlEntry(t, node, handlers),
        ]),
      ];

    case "routine":
    case "sequence":
    case "trigger":
      return [
        copyEntry(t, node, handlers),
        refreshEntry(t, node, handlers),
        separator("quickDoc.separator"),
        quickDocEntry(t, node, handlers),
        navigationEntry(t, [goToDdlEntry(t, node, handlers)]),
        scriptsEntry(t, ddlEntries(t, node, handlers)),
        separator("drop.separator"),
        dropEntry(t, node, handlers),
      ];
  }
}
