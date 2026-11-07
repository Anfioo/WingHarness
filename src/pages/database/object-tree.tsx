import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Columns3,
  Database as DatabaseIcon,
  Eye,
  FolderClosed,
  ListOrdered,
  Loader2,
  RefreshCw,
  SquareFunction,
  Table2,
} from "lucide-react";
import { toast } from "sonner";
import {
  databaseErrorCode,
  dbDatabases,
  dbDdl,
  dbObjectDdl,
  dbSchemaObjects,
  dbSchemas,
  dbTableDetails,
  dbTables,
} from "@/commands";
import type {
  ColumnInfo,
  DataSourceView,
  Databases,
  DbTableKind,
  RoutineInfo,
  SchemaObjects,
  SequenceInfo,
  TableDetails,
  TableInfo,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { ObjectDialog, dialogKey, type ObjectDialogState } from "./object-dialogs";
import { scriptSql, type DbObjectRef, type ScriptKind } from "./object-sql";
import {
  SCRIPT_ITEM_PREFIX,
  buildTreeMenu,
  type TreeMenuItem,
  type TreeMenuHandlers,
  type TreeMenuTarget,
} from "./tree-menu";
import {
  listsDatabases,
  objectFilterOf,
  passesObjectFilter,
  selectSql,
  shownDatabases,
  shownSchemas,
  targetOf,
  type Loaded,
} from "./tree-model";
import { useDatabaseTabs } from "./window-tabs";

/** IDEA's folders under a schema. */
type Folder = "tables" | "views" | "materializedViews" | "routines" | "sequences";

const FOLDERS: readonly Folder[] = [
  "tables",
  "views",
  "materializedViews",
  "routines",
  "sequences",
];

const EMPTY_OBJECTS: SchemaObjects = { routines: [], sequences: [] };

type TreeNode =
  | { kind: "source"; key: string }
  | { kind: "database"; key: string; id: string; name: string; current: boolean }
  | { kind: "schema"; key: string; id: string; schema: string }
  | { kind: "folder"; key: string; id: string; schema: string; folder: Folder }
  | { kind: "table"; key: string; id: string; schema: string; table: TableInfo }
  | { kind: "routine"; key: string; id: string; schema: string; routine: RoutineInfo }
  | { kind: "sequence"; key: string; id: string; schema: string; sequence: SequenceInfo }
  | { kind: "column"; key: string; id: string; schema: string; table: string; column: ColumnInfo }
  | { kind: "message"; key: string; text: string; error?: boolean; loading?: boolean };

const relationsKey = (target: string, schema: string) => `${target}\u0000${schema}`;
const detailsKey = (target: string, schema: string, table: string) =>
  `${target}\u0000${schema}\u0000${table}`;

function loadingNode(parent: string): TreeNode {
  return { kind: "message", key: `${parent}/loading`, text: "", loading: true };
}

function messageNode(parent: string, text: string, error = false): TreeNode {
  return { kind: "message", key: `${parent}/${error ? "error" : "empty"}`, text, error };
}

function isExpandable(node: TreeNode): boolean {
  switch (node.kind) {
    case "source":
    case "database":
    case "schema":
    case "folder":
    case "table":
      return true;
    default:
      return false;
  }
}

function tableKindOf(folder: Folder): DbTableKind {
  if (folder === "views") return "view";
  if (folder === "materializedViews") return "materializedView";
  return "table";
}

/**
 * Renders a flat menu, folding the `script.` entries into the SQL Scripts
 * submenu that follows the Definition item.
 */
function TreeMenuList({ items }: { items: TreeMenuItem[] }) {
  const { t } = useAppTranslation();
  const scripts = items.filter((item) => item.id.startsWith(SCRIPT_ITEM_PREFIX));
  const others = items.filter((item) => !item.id.startsWith(SCRIPT_ITEM_PREFIX));

  return (
    <>
      {others.map((item, index) => (
        <Fragment key={item.id}>
          {(item.id === "drop" || item.id === "refresh") && index > 0 && <ContextMenuSeparator />}
          <ContextMenuItem
            disabled={item.disabled}
            variant={item.destructive ? "destructive" : "default"}
            onSelect={() => item.run()}
          >
            {item.label}
          </ContextMenuItem>
          {item.id === "ddl" && scripts.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>{t("database.object.scripts")}</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {scripts.map((entry) => (
                  <ContextMenuItem
                    key={entry.id}
                    disabled={entry.disabled}
                    onSelect={() => entry.run()}
                  >
                    {entry.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The object tree of one data source: databases (PostgreSQL), schemas, folders
 * of tables / views / routines / sequences, and a table's columns.
 *
 * Every level loads the first time it is expanded; Refresh re-reads every level
 * that is already loaded and keeps the expanded nodes. Double-clicking a table
 * opens it in a tab, Ctrl+double-click pastes a `SELECT` into the console, and
 * the context menu holds the object's management actions. Every action shows
 * the SQL it will run, and the preview is the confirmation.
 */
export function ObjectTree({
  source,
  enabled,
  onInsertSelect,
}: {
  source: DataSourceView;
  /** The console is connected; introspection needs a pool. */
  enabled: boolean;
  /** `target` is the connection the table lives on (`<id>` or `<id>:<database>`). */
  onInsertSelect: (target: string, sql: string) => void;
}) {
  const { t } = useAppTranslation();
  const { openConsole, openTable } = useDatabaseTabs();
  const sourceId = source.id;
  const showDatabases = listsDatabases(source);

  const [databases, setDatabases] = useState<Loaded<Databases> | null>(null);
  /** Connection target → its schemas. */
  const [schemas, setSchemas] = useState<Record<string, Loaded<string[]>>>({});
  /** `${target}\u0000${schema}` → its tables and views. */
  const [relations, setRelations] = useState<Record<string, Loaded<TableInfo[]>>>({});
  /** Same key as `relations` → its routines and sequences. */
  const [objects, setObjects] = useState<Record<string, SchemaObjects>>({});
  /** `${target}\u0000${schema}\u0000${table}` → its columns and keys. */
  const [details, setDetails] = useState<Record<string, Loaded<TableDetails>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<ObjectDialogState | null>(null);

  const describeFailure = useCallback(
    (failure: unknown) => {
      const code = databaseErrorCode(failure);
      if (code) {
        return t(`database.error.${code}`, {
          defaultValue: (failure as { message: string }).message,
        });
      }
      return failure instanceof Error ? failure.message : String(failure);
    },
    [t]
  );

  const loadDatabases = useCallback(async () => {
    setDatabases({ status: "loading" });
    try {
      setDatabases({ status: "ok", value: await dbDatabases(sourceId) });
    } catch (failure) {
      setDatabases({ status: "error", message: describeFailure(failure) });
    }
  }, [describeFailure, sourceId]);

  const loadSchemas = useCallback(
    async (target: string) => {
      setSchemas((current) => ({ ...current, [target]: { status: "loading" } }));
      try {
        const value = await dbSchemas(target);
        setSchemas((current) => ({ ...current, [target]: { status: "ok", value } }));
      } catch (failure) {
        setSchemas((current) => ({
          ...current,
          [target]: { status: "error", message: describeFailure(failure) },
        }));
      }
    },
    [describeFailure]
  );

  const loadRelations = useCallback(
    async (target: string, schema: string) => {
      const key = relationsKey(target, schema);
      setRelations((current) => ({ ...current, [key]: { status: "loading" } }));
      try {
        // Routines and sequences are extras: a server refusing their catalog
        // still lists the tables.
        const [value, schemaObjects] = await Promise.all([
          dbTables(target, schema),
          dbSchemaObjects(target, schema).catch(() => null),
        ]);
        setRelations((current) => ({ ...current, [key]: { status: "ok", value } }));
        if (schemaObjects) setObjects((current) => ({ ...current, [key]: schemaObjects }));
      } catch (failure) {
        setRelations((current) => ({
          ...current,
          [key]: { status: "error", message: describeFailure(failure) },
        }));
      }
    },
    [describeFailure]
  );

  const loadDetails = useCallback(
    async (target: string, schema: string, table: string) => {
      const key = detailsKey(target, schema, table);
      setDetails((current) => ({ ...current, [key]: { status: "loading" } }));
      try {
        const value = await dbTableDetails(target, schema, table);
        setDetails((current) => ({ ...current, [key]: { status: "ok", value } }));
      } catch (failure) {
        setDetails((current) => ({
          ...current,
          [key]: { status: "error", message: describeFailure(failure) },
        }));
      }
    },
    [describeFailure]
  );

  // The first level loads as soon as there is a pool; a disconnect clears the
  // tree so the next connect starts from a clean slate.
  useEffect(() => {
    if (enabled) return;
    setDatabases(null);
    setSchemas({});
    setRelations({});
    setObjects({});
    setDetails({});
    setExpanded(new Set());
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (showDatabases) {
      if (!databases) void loadDatabases();
    } else if (!schemas[sourceId]) {
      void loadSchemas(sourceId);
    }
  }, [databases, enabled, loadDatabases, loadSchemas, schemas, showDatabases, sourceId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (showDatabases) await loadDatabases();
      const targets = Object.keys(schemas);
      await Promise.all(targets.map((target) => loadSchemas(target)));
      await Promise.all(
        Object.keys(relations).map((key) => {
          const [target, schema] = key.split("\u0000");
          return target && schema ? loadRelations(target, schema) : Promise.resolve();
        })
      );
      await Promise.all(
        Object.keys(details).map((key) => {
          const [target, schema, table] = key.split("\u0000");
          return target && schema && table ? loadDetails(target, schema, table) : Promise.resolve();
        })
      );
    } finally {
      setRefreshing(false);
    }
  }, [
    details,
    loadDatabases,
    loadDetails,
    loadRelations,
    loadSchemas,
    relations,
    schemas,
    showDatabases,
  ]);

  const insertSql = useCallback(
    (target: string, sql: string) => {
      onInsertSelect(target, sql);
      openConsole();
    },
    [onInsertSelect, openConsole]
  );

  const insertScript = useCallback(
    async (target: string, kind: ScriptKind, schema: string, table: string) => {
      try {
        const details = await dbTableDetails(target, schema, table);
        // ClickHouse rewrites only non-sorting-key columns; with none there is
        // nothing the template could set.
        if (
          source.driver === "clickhouse" &&
          kind === "update" &&
          details.columns.every((column) => column.primaryKey)
        ) {
          toast.error(t("database.object.scriptFailed"));
          return;
        }
        insertSql(target, scriptSql(source.driver, kind, schema, table, details.columns));
      } catch (failure) {
        toast.error(describeFailure(failure));
      }
    },
    [describeFailure, insertSql, source.driver, t]
  );

  const showDdl = useCallback(
    async (target: string, schema: string, object: DbObjectRef) => {
      const toastId = toast.loading(t("database.tree.loading"));
      try {
        let sql: string;
        switch (object.kind) {
          case "function":
          case "procedure":
          case "trigger":
          case "sequence":
            sql = await dbObjectDdl(target, schema, object.kind, object.name);
            break;
          default:
            sql = await dbDdl(target, schema, object.name);
        }
        toast.dismiss(toastId);
        setDialog({ kind: "ddl", target, sql });
      } catch (failure) {
        toast.dismiss(toastId);
        toast.error(t("database.ddl.failed", { error: describeFailure(failure) }));
      }
    },
    [describeFailure, t]
  );

  const menuTargetOf = (node: TreeNode): TreeMenuTarget | null => {
    const driver = source.driver;
    switch (node.kind) {
      case "source":
        return { kind: "source", id: sourceId, driver };
      case "database":
        return {
          kind: "database",
          id: node.id,
          driver,
          name: node.name,
          current: node.current,
        };
      case "schema":
        return { kind: "schema", id: node.id, driver, schema: node.schema };
      case "folder":
        return { kind: "folder", id: node.id, driver, schema: node.schema };
      case "table":
        return { kind: "table", id: node.id, driver, schema: node.schema, table: node.table };
      case "routine":
        return {
          kind: "routine",
          id: node.id,
          driver,
          schema: node.schema,
          routine: node.routine,
        };
      case "sequence":
        return {
          kind: "sequence",
          id: node.id,
          driver,
          schema: node.schema,
          name: node.sequence.name,
        };
      default:
        return null;
    }
  };

  const menuHandlers: TreeMenuHandlers = {
    newTable: (target, schema) => setDialog({ kind: "newTable", target, schema }),
    rename: (target, object) => setDialog({ kind: "rename", target, object }),
    drop: (target, object) => setDialog({ kind: "drop", target, object }),
    truncate: (target, schema, table) => setDialog({ kind: "truncate", target, schema, table }),
    modify: (target, schema, table) => setDialog({ kind: "modify", target, schema, table }),
    showDdl,
    script: (target, kind, schema, table) => void insertScript(target, kind, schema, table),
    refresh: () => void refresh(),
  };

  const ensureChildren = (node: TreeNode) => {
    switch (node.kind) {
      case "source":
        if (showDatabases) {
          if (!databases || databases.status === "error") void loadDatabases();
        } else if (!schemas[sourceId] || schemas[sourceId].status === "error") {
          void loadSchemas(sourceId);
        }
        break;
      case "database":
        if (!schemas[node.id] || schemas[node.id].status === "error") void loadSchemas(node.id);
        break;
      case "schema": {
        const loaded = relations[relationsKey(node.id, node.schema)];
        if (!loaded || loaded.status === "error") void loadRelations(node.id, node.schema);
        break;
      }
      case "table": {
        const loaded = details[detailsKey(node.id, node.schema, node.table.name)];
        if (!loaded || loaded.status === "error") {
          void loadDetails(node.id, node.schema, node.table.name);
        }
        break;
      }
      default:
        break;
    }
  };

  const toggle = (node: TreeNode) => {
    if (expanded.has(node.key)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(node.key);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(node.key));
    ensureChildren(node);
  };

  const schemasOf = (target: string, parent: string): TreeNode[] => {
    const loaded = schemas[target];
    if (!loaded || loaded.status === "loading") return [loadingNode(parent)];
    if (loaded.status === "error") return [messageNode(parent, loaded.message, true)];
    const names = shownSchemas(source, loaded.value);
    if (names.length === 0) return [messageNode(parent, t("database.tree.empty"))];
    return names.map((schema) => ({
      kind: "schema" as const,
      key: `${parent}/schema/${schema}`,
      id: target,
      schema,
    }));
  };

  const folderSize = (
    tables: readonly TableInfo[],
    schemaObjects: SchemaObjects,
    folder: Folder,
    visible: (name: string) => boolean
  ): number => {
    if (folder === "routines")
      return schemaObjects.routines.filter((item) => visible(item.name)).length;
    if (folder === "sequences")
      return schemaObjects.sequences.filter((item) => visible(item.name)).length;
    const kind = tableKindOf(folder);
    return tables.filter((table) => table.kind === kind && visible(table.name)).length;
  };

  const childrenOf = (node: TreeNode): TreeNode[] => {
    switch (node.kind) {
      case "source": {
        if (!showDatabases) return schemasOf(sourceId, node.key);
        if (!databases || databases.status === "loading") return [loadingNode(node.key)];
        if (databases.status === "error") return [messageNode(node.key, databases.message, true)];
        const names = shownDatabases(source, databases.value.names, databases.value.current);
        if (names.length === 0) return [messageNode(node.key, t("database.tree.empty"))];
        return names.map((name) => ({
          kind: "database" as const,
          key: `${node.key}/db/${name}`,
          id: targetOf(sourceId, name, databases.value.current),
          name,
          current: name === databases.value.current,
        }));
      }
      case "database":
        return schemasOf(node.id, node.key);
      case "schema": {
        const key = relationsKey(node.id, node.schema);
        const loaded = relations[key];
        if (!loaded || loaded.status === "loading") return [loadingNode(node.key)];
        if (loaded.status === "error") return [messageNode(node.key, loaded.message, true)];
        const visible = (name: string) => passesObjectFilter(name, objectFilterOf(source));
        const schemaObjects = objects[key] ?? EMPTY_OBJECTS;
        const folders = FOLDERS.filter(
          (folder) => folderSize(loaded.value, schemaObjects, folder, visible) > 0
        );
        if (folders.length === 0) return [messageNode(node.key, t("database.tree.emptySchema"))];
        return folders.map((folder) => ({
          kind: "folder" as const,
          key: `${node.key}/${folder}`,
          id: node.id,
          schema: node.schema,
          folder,
        }));
      }
      case "folder": {
        const key = relationsKey(node.id, node.schema);
        const loaded = relations[key];
        if (!loaded || loaded.status !== "ok") return [];
        const visible = (name: string) => passesObjectFilter(name, objectFilterOf(source));
        if (node.folder === "routines") {
          return (objects[key]?.routines ?? [])
            .filter((routine) => visible(routine.name))
            .map((routine) => ({
              kind: "routine" as const,
              key: `${node.key}/${routine.name}(${routine.arguments})`,
              id: node.id,
              schema: node.schema,
              routine,
            }));
        }
        if (node.folder === "sequences") {
          return (objects[key]?.sequences ?? [])
            .filter((sequence) => visible(sequence.name))
            .map((sequence) => ({
              kind: "sequence" as const,
              key: `${node.key}/${sequence.name}`,
              id: node.id,
              schema: node.schema,
              sequence,
            }));
        }
        const kind = tableKindOf(node.folder);
        return loaded.value
          .filter((table) => table.kind === kind && visible(table.name))
          .map((table) => ({
            kind: "table" as const,
            key: `${node.key}/${table.name}`,
            id: node.id,
            schema: node.schema,
            table,
          }));
      }
      case "table": {
        const loaded = details[detailsKey(node.id, node.schema, node.table.name)];
        if (!loaded || loaded.status === "loading") return [loadingNode(node.key)];
        if (loaded.status === "error") return [messageNode(node.key, loaded.message, true)];
        if (loaded.value.columns.length === 0) {
          return [messageNode(node.key, t("database.tree.emptyColumns"))];
        }
        return loaded.value.columns.map((column) => ({
          kind: "column" as const,
          key: `${node.key}/${column.name}`,
          id: node.id,
          schema: node.schema,
          table: node.table.name,
          column,
        }));
      }
      default:
        return [];
    }
  };

  const labelOf = (node: TreeNode): string => {
    switch (node.kind) {
      case "source":
        return source.name;
      case "database":
        return node.name;
      case "schema":
        return node.schema;
      case "folder":
        return t(`database.tree.folder.${node.folder}`);
      case "table":
        return node.table.name;
      case "routine":
        return node.routine.name;
      case "sequence":
        return node.sequence.name;
      case "column":
        return node.column.name;
      case "message":
        return node.text;
    }
  };

  const detailOf = (node: TreeNode): string | undefined => {
    switch (node.kind) {
      case "routine":
        return `(${node.routine.arguments})${node.routine.returns ? `: ${node.routine.returns}` : ""}`;
      case "sequence":
        return node.sequence.dataType;
      case "column":
        return node.column.primaryKey ? `${node.column.dataType} · PK` : node.column.dataType;
      default:
        return undefined;
    }
  };

  const iconOf = (node: TreeNode): ReactNode => {
    switch (node.kind) {
      case "database":
        return <DatabaseIcon className="size-3.5 shrink-0" />;
      case "schema":
      case "folder":
        return <FolderClosed className="size-3.5 shrink-0" />;
      case "table":
        return node.table.kind === "table" ? (
          <Table2 className="size-3.5 shrink-0" />
        ) : (
          <Eye className="size-3.5 shrink-0" />
        );
      case "routine":
        return <SquareFunction className="size-3.5 shrink-0" />;
      case "sequence":
        return <ListOrdered className="size-3.5 shrink-0" />;
      case "column":
        return (
          <Columns3
            className={
              node.column.primaryKey
                ? "size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                : "size-3.5 shrink-0"
            }
          />
        );
      case "message":
        return node.loading ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : node.error ? (
          <AlertTriangle className="text-destructive size-3 shrink-0" />
        ) : null;
      default:
        return null;
    }
  };

  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) => renderNode(node, depth));

  function renderNode(node: TreeNode, depth: number): ReactNode {
    if (node.kind === "message") {
      return (
        <div
          key={node.key}
          className="text-muted-foreground flex items-start gap-1.5 py-1 pr-2 text-[11px]"
          style={{ paddingLeft: 12 + depth * 12 }}
        >
          {iconOf(node)}
          <span className={node.error ? "text-destructive break-words" : "break-words"}>
            {node.loading ? t("database.tree.loading") : node.text}
          </span>
        </div>
      );
    }

    const open = expanded.has(node.key);
    const expandable = isExpandable(node);
    const detail = detailOf(node);
    const target = menuTargetOf(node);

    const trigger = (
      <button
        type="button"
        className="hover:bg-accent/60 flex w-full items-center gap-1.5 py-1 pr-2 text-left"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={
          node.kind === "table"
            ? t("database.tree.openTable")
            : expandable
              ? labelOf(node)
              : undefined
        }
        onClick={() => {
          if (expandable) toggle(node);
        }}
        onDoubleClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          if (node.kind !== "table") return;
          if (event.ctrlKey || event.metaKey) {
            insertSql(node.id, selectSql(source.driver, node.schema, node.table.name));
            return;
          }
          openTable(node.id, node.schema, node.table.name);
        }}
      >
        {expandable ? (
          open ? (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        {iconOf(node)}
        <span className="truncate text-xs">{labelOf(node)}</span>
        {node.kind === "database" && node.current && (
          <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px]">
            {t("database.tree.current")}
          </Badge>
        )}
        {detail && (
          <span className="text-muted-foreground ml-auto shrink-0 pl-2 font-mono text-[10px]">
            {detail}
          </span>
        )}
      </button>
    );

    return (
      <div key={node.key} role="treeitem" aria-expanded={expandable ? open : undefined}>
        {target ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              <TreeMenuList items={buildTreeMenu(target, (key) => t(key), menuHandlers)} />
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          trigger
        )}
        {expandable && open && <div role="group">{renderNodes(childrenOf(node), depth + 1)}</div>}
      </div>
    );
  }

  const root: TreeNode = { kind: "source", key: `source:${sourceId}` };

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col" aria-label={t("database.tree.title")}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">{t("database.tree.title")}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!enabled || refreshing}
            aria-label={t("database.action.refresh")}
            title={t("database.action.refresh")}
            onClick={() => void refresh()}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1" role="tree">
          {enabled ? (
            renderNodes(childrenOf(root), 0)
          ) : (
            <p className="text-muted-foreground px-3 py-2 text-[11px]">
              {t("database.tree.connectFirst")}
            </p>
          )}
        </div>
      </section>
      {dialog && (
        <ObjectDialog
          key={dialogKey(dialog)}
          dialog={dialog}
          driver={source.driver}
          onClose={() => setDialog(null)}
          onChanged={() => void refresh()}
          onInsertSql={insertSql}
        />
      )}
    </>
  );
}
