// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Dialogs of the object tree's actions: Rename, Drop, Truncate, New Table and
 * Modify Table. Each one renders the SQL it is about to run, and the preview is
 * the confirmation: pressing its primary button executes exactly that text.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Plus, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import {
  databaseErrorCode,
  dbExecute,
  dbTableDetails,
  type ColumnInfo,
  type DbDriver,
} from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import {
  alterTableSql,
  canAlterColumn,
  createTableSql,
  draftOf,
  dropSql,
  reference,
  renameSql,
  truncateSql,
  type ColumnDraft,
  type DbObjectRef,
} from "./object-sql";
import { SqlPreview } from "./sql-preview";

export type ObjectDialogState =
  | { kind: "rename"; target: string; object: DbObjectRef }
  | { kind: "drop"; target: string; object: DbObjectRef }
  | { kind: "truncate"; target: string; schema: string; table: string }
  | { kind: "newTable"; target: string; schema: string }
  | { kind: "modify"; target: string; schema: string; table: string }
  | { kind: "ddl"; target: string; sql: string };

/** Stable React key of a dialog, so reopening it for another object resets the form. */
export function dialogKey(dialog: ObjectDialogState): string {
  switch (dialog.kind) {
    case "rename":
    case "drop":
      return `${dialog.kind}:${dialog.target}:${dialog.object.kind}:${dialog.object.name}`;
    case "truncate":
    case "modify":
      return `${dialog.kind}:${dialog.target}:${dialog.schema}:${dialog.table}`;
    case "newTable":
      return `${dialog.kind}:${dialog.target}:${dialog.schema}`;
    case "ddl":
      return `${dialog.kind}:${dialog.target}`;
  }
}

function useDescribeFailure() {
  const { t } = useAppTranslation();
  return useCallback(
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
}

/** Runs a generated script, then closes the dialog and refreshes the tree. */
function useExecutor(target: string, onChanged: () => void, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const describe = useDescribeFailure();

  const run = useCallback(
    async (statements: string[]) => {
      if (running.current || statements.length === 0) return;
      running.current = true;
      setBusy(true);
      try {
        const request = crypto.randomUUID();
        const outcomes = await dbExecute(
          request,
          target,
          statements.map((text) => ({ from: 0, to: 0, text })),
          0,
          0
        );
        const failed = outcomes.find((outcome) => outcome.error !== null);
        if (failed?.error) {
          toast.error(describe(failed.error));
          return;
        }
        onChanged();
        onClose();
      } catch (failure) {
        toast.error(describe(failure));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [describe, onChanged, onClose, target]
  );

  return { busy, run };
}

function DialogShell({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function Check({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="accent-primary size-3.5"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={disabled ? "text-muted-foreground" : undefined}>{label}</span>
    </label>
  );
}

// ---- Rename ------------------------------------------------------------------

function RenameDialog({
  dialog,
  driver,
  onClose,
  onChanged,
  onInsertSql,
}: {
  dialog: Extract<ObjectDialogState, { kind: "rename" }>;
  driver: DbDriver;
  onClose: () => void;
  onChanged: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  const { t } = useAppTranslation();
  const [name, setName] = useState(dialog.object.name);
  const { busy, run } = useExecutor(dialog.target, onChanged, onClose);
  const trimmed = name.trim();
  const changed = trimmed !== "" && trimmed !== dialog.object.name;
  const sql = changed ? renameSql(driver, dialog.object, trimmed) : "";

  const submit = () => {
    if (!changed) {
      onClose();
      return;
    }
    void run([sql]);
  };

  return (
    <DialogShell
      title={t("database.object.rename")}
      description={t("database.object.renameBody", { name: reference(driver, dialog.object) })}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="db-object-name">{t("database.form.name")}</Label>
        <Input
          id="db-object-name"
          autoFocus
          value={name}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <SqlPreview
        sql={sql || `-- ${t("database.object.noChanges")}`}
        title={t("database.object.preview")}
        busy={busy}
        executeLabel={t("database.object.rename")}
        onExecute={submit}
        onOpenInConsole={() => {
          if (sql) onInsertSql(dialog.target, sql);
          onClose();
        }}
        onCancel={onClose}
      />
    </DialogShell>
  );
}

// ---- Drop / Truncate -----------------------------------------------------------

function DropDialog({
  dialog,
  driver,
  onClose,
  onChanged,
  onInsertSql,
}: {
  dialog: Extract<ObjectDialogState, { kind: "drop" }>;
  driver: DbDriver;
  onClose: () => void;
  onChanged: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  const { t } = useAppTranslation();
  const [ifExists, setIfExists] = useState(false);
  const [cascade, setCascade] = useState(false);
  const { busy, run } = useExecutor(dialog.target, onChanged, onClose);
  const sql = dropSql(driver, dialog.object, { ifExists, cascade });
  const ifExistsAvailable =
    !(dialog.object.kind === "column" && driver !== "postgres") &&
    !(dialog.object.kind === "index" && driver === "mysql");

  return (
    <DialogShell
      title={t("database.object.drop")}
      description={t("database.object.dropBody", { name: reference(driver, dialog.object) })}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        <Check
          checked={ifExists}
          label={t("database.object.ifExists")}
          disabled={!ifExistsAvailable}
          onChange={setIfExists}
        />
        <Check
          checked={cascade}
          label={t("database.object.cascade")}
          disabled={driver !== "postgres"}
          onChange={setCascade}
        />
      </div>
      <SqlPreview
        sql={sql}
        title={t("database.object.preview")}
        busy={busy}
        executeLabel={t("database.object.drop")}
        onExecute={() => void run([sql])}
        onOpenInConsole={() => {
          onInsertSql(dialog.target, sql);
          onClose();
        }}
        onCancel={onClose}
      />
    </DialogShell>
  );
}

function TruncateDialog({
  dialog,
  driver,
  onClose,
  onChanged,
  onInsertSql,
}: {
  dialog: Extract<ObjectDialogState, { kind: "truncate" }>;
  driver: DbDriver;
  onClose: () => void;
  onChanged: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  const { t } = useAppTranslation();
  const [restartIdentity, setRestartIdentity] = useState(false);
  const [cascade, setCascade] = useState(false);
  const { busy, run } = useExecutor(dialog.target, onChanged, onClose);
  const sql = truncateSql(driver, dialog.schema, dialog.table, { restartIdentity, cascade });

  return (
    <DialogShell
      title={t("database.object.truncate")}
      description={t("database.object.truncateBody", { table: dialog.table })}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        <Check
          checked={restartIdentity}
          label={t("database.object.restartIdentity")}
          disabled={driver !== "postgres"}
          onChange={setRestartIdentity}
        />
        <Check
          checked={cascade}
          label={t("database.object.cascade")}
          disabled={driver !== "postgres"}
          onChange={setCascade}
        />
      </div>
      <SqlPreview
        sql={sql}
        title={t("database.object.preview")}
        busy={busy}
        executeLabel={t("database.object.truncate")}
        onExecute={() => void run([sql])}
        onOpenInConsole={() => {
          onInsertSql(dialog.target, sql);
          onClose();
        }}
        onCancel={onClose}
      />
    </DialogShell>
  );
}

// ---- New Table / Modify Table -----------------------------------------------

const TYPES: Record<DbDriver, readonly string[]> = {
  sqlite: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB", "BOOLEAN", "DATE", "DATETIME"],
  postgres: [
    "integer",
    "bigint",
    "smallint",
    "serial",
    "bigserial",
    "numeric",
    "real",
    "double precision",
    "boolean",
    "text",
    "varchar(255)",
    "uuid",
    "date",
    "timestamp",
    "timestamptz",
    "jsonb",
    "bytea",
  ],
  mysql: [
    "int",
    "bigint",
    "smallint",
    "tinyint(1)",
    "decimal(10,2)",
    "double",
    "varchar(255)",
    "text",
    "date",
    "datetime",
    "timestamp",
    "json",
    "blob",
  ],
  sqlServer: [
    "int",
    "bigint",
    "smallint",
    "tinyint",
    "decimal(10,2)",
    "float",
    "real",
    "varchar(255)",
    "nvarchar(255)",
    "text",
    "ntext",
    "date",
    "datetime",
    "datetime2",
    "uniqueidentifier",
    "bit",
    "varbinary(max)",
  ],
  clickhouse: [
    "UInt64",
    "Int64",
    "Float64",
    "String",
    "Bool",
    "Date",
    "DateTime",
    "UUID",
    "Nullable(String)",
  ],
  oracle: [
    "NUMBER",
    "NUMBER(10)",
    "NUMBER(19, 4)",
    "INTEGER",
    "BINARY_FLOAT",
    "BINARY_DOUBLE",
    "VARCHAR2(255)",
    "VARCHAR2(4000)",
    "NVARCHAR2(255)",
    "CHAR(1)",
    "CLOB",
    "BLOB",
    "RAW(16)",
    "DATE",
    "TIMESTAMP",
    "TIMESTAMP WITH TIME ZONE",
    "INTERVAL DAY TO SECOND",
    "XMLTYPE",
  ],
};

let nextDraftKey = 1000;

function blankColumn(driver: DbDriver, index: number): ColumnDraft {
  return {
    key: nextDraftKey++,
    original: null,
    name: `column_${index}`,
    dataType: TYPES[driver][0] ?? "",
    notNull: false,
    default: "",
    primaryKey: false,
    dropped: false,
  };
}

function TableForm({
  target,
  schema,
  driver,
  table,
  initial,
  onClose,
  onChanged,
  onInsertSql,
}: {
  target: string;
  schema: string;
  driver: DbDriver;
  table: string | null;
  initial: ColumnInfo[] | null;
  onClose: () => void;
  onChanged: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  const { t } = useAppTranslation();
  const [name, setName] = useState(table ?? "table_name");
  const [columns, setColumns] = useState<ColumnDraft[]>(() => {
    if (initial) return initial.map((column, index) => draftOf(column, index));
    return [
      { ...blankColumn(driver, 1), name: "id", primaryKey: driver !== "clickhouse", notNull: true },
    ];
  });
  const { busy, run } = useExecutor(target, onChanged, onClose);

  const statements = useMemo(
    () =>
      table
        ? alterTableSql(driver, schema, table, name, columns)
        : [createTableSql(driver, schema, name.trim() || "table_name", columns)],
    [columns, driver, name, schema, table]
  );
  const sql = statements.join("\n") || `-- ${t("database.object.noChanges")}`;
  const canSubmit = statements.length > 0 && name.trim() !== "";
  const typeListId = `db-types-${driver}`;

  const patch = (key: number, change: Partial<ColumnDraft>) =>
    setColumns((current) =>
      current.map((column) => (column.key === key ? { ...column, ...change } : column))
    );

  const addColumn = () =>
    setColumns((current) => [...current, blankColumn(driver, current.length + 1)]);

  const removeColumn = (column: ColumnDraft) => {
    if (column.original) patch(column.key, { dropped: !column.dropped });
    else setColumns((current) => current.filter((entry) => entry.key !== column.key));
  };

  const grid = table
    ? "grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_auto_minmax(0,1.2fr)_auto]"
    : "grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_auto_minmax(0,1.2fr)_auto_auto]";

  return (
    <DialogShell
      title={table ? `${t("database.object.modify")} ${table}` : t("database.object.newTable")}
      description={schema}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="db-table-name" className="w-20 shrink-0">
            {t("database.tab.table")}
          </Label>
          <Input
            id="db-table-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus={table === null}
          />
        </div>
        <div className="max-h-64 overflow-auto rounded-md border">
          <div
            className={cn(
              "bg-muted/50 text-muted-foreground sticky top-0 grid gap-2 border-b px-2 py-1 text-[11px]",
              grid
            )}
          >
            <span>{t("database.form.name")}</span>
            <span>{t("database.object.dataType")}</span>
            <span>{t("database.object.notNull")}</span>
            <span>{t("database.object.defaultValue")}</span>
            {!table && <span>{t("database.object.primaryKey")}</span>}
            <span />
          </div>
          {columns.map((column) => {
            const locked = !canAlterColumn(driver, column) || column.dropped;
            const actionLabel = column.dropped
              ? t("database.object.keepColumn")
              : t("database.object.dropColumn");
            return (
              <div
                key={column.key}
                className={cn(
                  "grid items-center gap-2 border-b px-2 py-1 last:border-b-0",
                  grid,
                  column.dropped && "opacity-50"
                )}
              >
                <Input
                  className="h-8"
                  value={column.name}
                  disabled={column.dropped}
                  onChange={(event) => patch(column.key, { name: event.target.value })}
                />
                <Input
                  className="h-8 font-mono"
                  list={typeListId}
                  value={column.dataType}
                  disabled={locked}
                  onChange={(event) => patch(column.key, { dataType: event.target.value })}
                />
                <input
                  type="checkbox"
                  className="accent-primary size-3.5"
                  checked={column.notNull}
                  disabled={locked}
                  aria-label={t("database.object.notNull")}
                  onChange={(event) => patch(column.key, { notNull: event.target.checked })}
                />
                <Input
                  className="h-8 font-mono"
                  placeholder="default"
                  value={column.default}
                  disabled={locked}
                  onChange={(event) => patch(column.key, { default: event.target.value })}
                />
                {!table && (
                  <input
                    type="checkbox"
                    className="accent-primary size-3.5"
                    checked={column.primaryKey}
                    aria-label={t("database.object.primaryKey")}
                    onChange={(event) => patch(column.key, { primaryKey: event.target.checked })}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={actionLabel}
                  aria-label={actionLabel}
                  onClick={() => removeColumn(column)}
                >
                  {column.dropped ? <Undo2 /> : <Trash2 />}
                </Button>
              </div>
            );
          })}
        </div>
        <datalist id={typeListId}>
          {TYPES[driver].map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addColumn}>
            <Plus />
            {t("database.object.addColumn")}
          </Button>
          {table && driver === "sqlite" && (
            <span className="text-muted-foreground text-[11px]">
              {t("database.object.sqliteAlterHint")}
            </span>
          )}
        </div>
      </div>
      <SqlPreview
        sql={sql}
        title={t("database.object.preview")}
        busy={busy}
        executeLabel={table ? t("database.object.modify") : t("database.object.newTable")}
        onExecute={() => {
          if (canSubmit) void run(statements);
        }}
        onOpenInConsole={() => {
          if (statements.length > 0) onInsertSql(target, statements.join("\n"));
          onClose();
        }}
        onCancel={onClose}
      />
    </DialogShell>
  );
}

function NewTableDialog(props: {
  dialog: Extract<ObjectDialogState, { kind: "newTable" }>;
  driver: DbDriver;
  onClose: () => void;
  onChanged: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  return (
    <TableForm
      target={props.dialog.target}
      schema={props.dialog.schema}
      driver={props.driver}
      table={null}
      initial={null}
      onClose={props.onClose}
      onChanged={props.onChanged}
      onInsertSql={props.onInsertSql}
    />
  );
}

function ModifyTableDialog({
  dialog,
  driver,
  onClose,
  onChanged,
  onInsertSql,
}: {
  dialog: Extract<ObjectDialogState, { kind: "modify" }>;
  driver: DbDriver;
  onClose: () => void;
  onChanged: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  const { t } = useAppTranslation();
  const describe = useDescribeFailure();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ok"; columns: ColumnInfo[] }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let live = true;
    dbTableDetails(dialog.target, dialog.schema, dialog.table)
      .then((details) => {
        if (live) setState({ status: "ok", columns: details.columns });
      })
      .catch((failure: unknown) => {
        if (live) setState({ status: "error", message: describe(failure) });
      });
    return () => {
      live = false;
    };
  }, [describe, dialog.schema, dialog.table, dialog.target]);

  if (state.status === "ok") {
    return (
      <TableForm
        target={dialog.target}
        schema={dialog.schema}
        driver={driver}
        table={dialog.table}
        initial={state.columns}
        onClose={onClose}
        onChanged={onChanged}
        onInsertSql={onInsertSql}
      />
    );
  }

  return (
    <DialogShell
      title={`${t("database.object.modify")} ${dialog.table}`}
      description={dialog.schema}
      onClose={onClose}
    >
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {state.status === "loading" ? (
          <>
            <Loader2 className="animate-spin" />
            {t("database.tree.loading")}
          </>
        ) : (
          <span className="text-destructive">{state.message}</span>
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="outline" onClick={onClose}>
          {t("database.form.cancel")}
        </Button>
      </div>
    </DialogShell>
  );
}

// ---- Definition --------------------------------------------------------------

function DdlDialog({
  dialog,
  onClose,
  onInsertSql,
}: {
  dialog: Extract<ObjectDialogState, { kind: "ddl" }>;
  onClose: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  const { t } = useAppTranslation();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(dialog.sql);
      toast.success(t("database.ddl.copied"));
    } catch {
      toast.error(t("database.grid.copyFailed"));
    }
  };

  return (
    <DialogShell
      title={t("database.ddl.title")}
      description={t("database.ddl.description")}
      onClose={onClose}
    >
      <SqlPreview
        sql={dialog.sql}
        title={t("database.object.preview")}
        executeLabel={t("database.grid.copy")}
        onExecute={() => void copy()}
        onOpenInConsole={() => {
          onInsertSql(dialog.target, dialog.sql);
          onClose();
        }}
        onCancel={onClose}
      />
    </DialogShell>
  );
}

export function ObjectDialog({
  dialog,
  driver,
  onClose,
  onChanged,
  onInsertSql,
}: {
  dialog: ObjectDialogState;
  driver: DbDriver;
  onClose: () => void;
  onChanged: () => void;
  onInsertSql: (target: string, sql: string) => void;
}) {
  switch (dialog.kind) {
    case "rename":
      return (
        <RenameDialog
          dialog={dialog}
          driver={driver}
          onClose={onClose}
          onChanged={onChanged}
          onInsertSql={onInsertSql}
        />
      );
    case "drop":
      return (
        <DropDialog
          dialog={dialog}
          driver={driver}
          onClose={onClose}
          onChanged={onChanged}
          onInsertSql={onInsertSql}
        />
      );
    case "truncate":
      return (
        <TruncateDialog
          dialog={dialog}
          driver={driver}
          onClose={onClose}
          onChanged={onChanged}
          onInsertSql={onInsertSql}
        />
      );
    case "newTable":
      return (
        <NewTableDialog
          dialog={dialog}
          driver={driver}
          onClose={onClose}
          onChanged={onChanged}
          onInsertSql={onInsertSql}
        />
      );
    case "modify":
      return (
        <ModifyTableDialog
          dialog={dialog}
          driver={driver}
          onClose={onClose}
          onChanged={onChanged}
          onInsertSql={onInsertSql}
        />
      );
    case "ddl":
      return <DdlDialog dialog={dialog} onClose={onClose} onInsertSql={onInsertSql} />;
  }
}
