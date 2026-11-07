// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Quick documentation of one schema object: its kind and schema, then the DDL
 * that recreates it. The dialog is controlled: the caller decides whether it
 * opens at an anchor or in the middle of the window.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { dbDdl, dbObjectDdl, databaseErrorCode } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { DbObjectRef } from "./object-sql";

export type QuickDocProps = {
  open: boolean;
  target: string;
  object: DbObjectRef;
  onOpenChange(open: boolean): void;
};

type DocState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; ddl: string }
  | { status: "missing" }
  | { status: "failed"; error: unknown };

/** Tables, views and columns read `db_ddl`; routines, triggers and sequences read `db_object_ddl`. */
function loadDdl(
  target: string,
  kind: DbObjectRef["kind"],
  schema: string,
  name: string,
  table: string | undefined
): Promise<string> | null {
  switch (kind) {
    case "function":
    case "procedure":
    case "trigger":
    case "sequence":
      return dbObjectDdl(target, schema, kind, name);
    case "schema":
      return null;
    case "index":
      return dbDdl(target, schema, table ?? name);
    default:
      return dbDdl(target, schema, name);
  }
}

const KIND_LABELS: Record<DbObjectRef["kind"], { key: string; title: string }> = {
  table: { key: "database.object.kind.table", title: "Table" },
  view: { key: "database.object.kind.view", title: "View" },
  materializedView: { key: "database.object.kind.materializedView", title: "Materialized view" },
  column: { key: "database.object.kind.column", title: "Column" },
  index: { key: "database.object.kind.index", title: "Index" },
  schema: { key: "database.object.kind.schema", title: "Schema" },
  function: { key: "database.object.kind.function", title: "Function" },
  procedure: { key: "database.object.kind.procedure", title: "Procedure" },
  trigger: { key: "database.object.kind.trigger", title: "Trigger" },
  sequence: { key: "database.object.kind.sequence", title: "Sequence" },
};

export function QuickDoc({ open, target, object, onOpenChange }: QuickDocProps): ReactNode {
  const { t } = useAppTranslation();

  const { kind, schema, name, table } = object;
  const [state, setState] = useState<DocState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const request = loadDdl(target, kind, schema, name, table);
    setState({ status: "loading" });
    if (!request) {
      setState({ status: "none" });
      return;
    }
    request.then(
      (ddl) => {
        if (live) setState({ status: "ready", ddl });
      },
      (error: unknown) => {
        if (!live) return;
        setState(
          databaseErrorCode(error) === "not-found"
            ? { status: "missing" }
            : { status: "failed", error }
        );
      }
    );
    return () => {
      live = false;
    };
  }, [open, target, kind, schema, name, table, attempt]);

  const describeFailure = (cause: unknown) => {
    const code = databaseErrorCode(cause);
    if (code) {
      return t(`database.error.${code}`, {
        defaultValue: (cause as { message: string }).message,
      });
    }
    return cause instanceof Error ? cause.message : String(cause);
  };

  const ddl = state.status === "ready" ? state.ddl : null;

  const copy = async () => {
    if (!ddl) return;
    try {
      await navigator.clipboard.writeText(ddl);
      toast.success(t("database.ddl.copied"));
    } catch {
      toast.error(t("database.grid.copyFailed"));
    }
  };

  const kindLabel = KIND_LABELS[kind];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("database.quickDoc.title")}</DialogTitle>
          <DialogDescription>{schema ? `${schema}.${name}` : name}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("database.object.dataType")}</dt>
          <dd>{t(kindLabel.key, { defaultValue: kindLabel.title })}</dd>
          {schema && (
            <>
              <dt className="text-muted-foreground">
                {t("database.quickDoc.schema", { defaultValue: "Schema" })}
              </dt>
              <dd className="font-mono text-xs">{schema}</dd>
            </>
          )}
        </dl>

        <div className="flex min-h-32 flex-col">
          {state.status === "loading" ? (
            <div className="flex flex-col gap-2 py-1">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <span className="text-muted-foreground mt-1 text-xs">
                {t("database.quickDoc.loading")}
              </span>
            </div>
          ) : state.status === "missing" ? (
            <p className="text-muted-foreground py-4 text-sm">
              {t("database.quickDoc.notFound", {
                defaultValue: "This object no longer exists.",
              })}
            </p>
          ) : state.status === "failed" ? (
            <div className="flex flex-col items-start gap-2 py-2">
              <p className="text-destructive text-sm">
                {t("database.quickDoc.failed", { error: describeFailure(state.error) })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAttempt((current) => current + 1)}
              >
                <RefreshCw />
                {t("database.action.retry")}
              </Button>
            </div>
          ) : ddl ? (
            <pre className="bg-muted/40 max-h-[50vh] min-h-32 overflow-auto rounded-md border p-3 font-mono text-xs leading-5">
              {ddl}
            </pre>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={!ddl} onClick={() => void copy()}>
            <Copy />
            {t("database.quickDoc.copy", { defaultValue: "Copy" })}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("database.quickDoc.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
