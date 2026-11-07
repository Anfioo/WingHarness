// The shell of a data source window: the object tree on the left, the tab strip
// and the active tab on the right.
//
// Tab state lives in the window store and nowhere else; this file only lays the
// store out and owns the two things the store cannot hold: the data source
// record the tree renders, and the password prompt.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Check,
  Database,
  FilePlus2,
  FolderOpen,
  Loader2,
  PanelLeft,
  Plug,
  PlugZap,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import {
  dbSourceList,
  dbSourceSave,
  dbSourceSetPassword,
  projectActive,
  setActiveProject,
  type DataSource,
  type DataSourceView,
} from "@/commands";
import { TitleBar } from "@/components/title-bar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";
import { ObjectTree, type ObjectTreeHandle } from "./object-tree";
import type { DbObjectRef } from "./object-sql";
import { QuickDoc } from "./quick-doc";
import { QueryTab, type QueryTabHandle } from "./query-tab";
import { SourceDialog, asSource } from "./source-dialog";
import { DatabaseStoreProvider, tabKey, useDatabaseStore } from "./store";
import { TabBar } from "./tab-bar";
import { TableEditor } from "./table-editor";
import { OpenQueryDialog, TreeToolbar } from "./tree-toolbar";
import type { TreeSelection } from "./tree-model";

/** The data source this window was opened for, taken from its own URL. */
function sourceFromUrl(search: string) {
  return new URLSearchParams(search).get("source") ?? "";
}

/** The project this window was opened against; empty when none was given. */
function rootFromUrl(search: string) {
  return new URLSearchParams(search).get("root") ?? "";
}

/** The text of a rejected command, whatever shape it arrived in. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True while the caret sits in a field or a code editor, which own Ctrl+T/W. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.closest(".cm-editor") !== null
  );
}

/** Opens a new query file and reports a write the workspace refused. */
function useNewQuery() {
  const openQuery = useDatabaseStore((state) => state.openQuery);
  return useCallback(() => {
    openQuery().catch((error: unknown) => toast.error(failureText(error)));
  }, [openQuery]);
}

/**
 * The connection row above the tree: where the window stands, how to change it,
 * and — under manual commit — how to end the transaction the last statement
 * left open.
 */
function ConnectionBar() {
  const { t } = useAppTranslation();
  const connection = useDatabaseStore((state) => state.connection);
  const manualCommit = useDatabaseStore((state) => state.manualCommit);
  const pendingTx = useDatabaseStore((state) => state.pendingTx);
  const connect = useDatabaseStore((state) => state.connect);
  const disconnect = useDatabaseStore((state) => state.disconnect);
  const setManualCommit = useDatabaseStore((state) => state.setManualCommit);
  const finishTransaction = useDatabaseStore((state) => state.finishTransaction);

  const connected = connection.status === "connected";
  const connecting = connection.status === "connecting";
  const failed = connection.status === "error";
  const status =
    connection.error ??
    (connected
      ? t("database.list.connected")
      : connecting
        ? t("database.window.connecting")
        : t("database.list.disconnected"));

  const finish = (commit: boolean) => {
    finishTransaction(commit)
      .then(() =>
        toast.success(commit ? t("database.window.committed") : t("database.window.rolledBack"))
      )
      .catch((error: unknown) => toast.error(failureText(error)));
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          connected
            ? "bg-emerald-500"
            : connecting
              ? "animate-pulse bg-amber-500"
              : failed
                ? "bg-destructive"
                : "bg-muted-foreground/40"
        )}
        title={status}
      />
      <span
        className={cn("min-w-0 flex-1 truncate text-xs", failed && "text-destructive")}
        title={status}
      >
        {status}
      </span>

      {connected ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("database.window.disconnect")}
          title={t("database.window.disconnect")}
          onClick={() => void disconnect()}
        >
          <Plug />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={connecting}
          aria-label={t("database.window.connect")}
          title={t("database.window.connect")}
          onClick={() => void connect()}
        >
          {connecting ? <Loader2 className="animate-spin" /> : <PlugZap />}
        </Button>
      )}

      <Switch
        id="database-window-manual-commit"
        className="shrink-0"
        checked={manualCommit}
        disabled={!connected}
        aria-label={t("database.form.manualCommit")}
        title={t("database.form.manualCommit")}
        onCheckedChange={(manual) => {
          setManualCommit(manual).catch((error: unknown) => toast.error(failureText(error)));
        }}
      />

      <Button
        variant="ghost"
        size="icon-xs"
        disabled={!pendingTx}
        aria-label={t("database.window.commit")}
        title={t("database.window.commit")}
        onClick={() => finish(true)}
      >
        <Check />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={!pendingTx}
        aria-label={t("database.window.rollback")}
        title={t("database.window.rollback")}
        onClick={() => finish(false)}
      >
        <RotateCcw />
      </Button>
    </div>
  );
}

/**
 * The prompt a source whose saved password did not work raises. The store keeps
 * `needsPassword` set until the next attempt clears it, so the dialog opens once
 * per attempt rather than re-opening after a cancel; cancelling leaves the
 * window disconnected. The password is only ever handed to `connect`.
 */
function PasswordDialog() {
  const { t } = useAppTranslation();
  const connection = useDatabaseStore((state) => state.connection);
  const connect = useDatabaseStore((state) => state.connect);

  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const prompted = useRef(false);

  useEffect(() => {
    if (!connection.needsPassword) {
      prompted.current = false;
      return;
    }
    if (prompted.current) return;
    prompted.current = true;
    setPassword("");
    setOpen(true);
  }, [connection.needsPassword]);

  const submit = () => {
    const typed = password;
    setOpen(false);
    setPassword("");
    void connect(typed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPassword("");
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("database.console.passwordTitle")}</DialogTitle>
          <DialogDescription>
            {connection.error ?? t("database.error.auth-failed")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="database-window-password" className="text-xs">
              {t("database.console.passwordLabel")}
            </Label>
            <Input
              id="database-window-password"
              type="password"
              value={password}
              autoComplete="current-password"
              autoFocus
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t("database.form.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={connection.status === "connecting"}>
              {connection.status === "connecting" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <PlugZap />
              )}
              {t("database.console.passwordSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The right column while nothing is open: the two ways to get a first tab. */
function EmptyWorkspace({ onOpenQuery }: { onOpenQuery(): void }) {
  const { t } = useAppTranslation();
  const newQuery = useNewQuery();

  return (
    <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Database className="size-9" />
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{t("database.workspace.empty")}</p>
        <p className="max-w-sm text-xs">{t("database.workspace.emptyHint")}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={newQuery}>
          <FilePlus2 />
          {t("database.workspace.newQuery")}
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenQuery}>
          <FolderOpen />
          {t("database.workspace.openQuery")}
        </Button>
      </div>
    </div>
  );
}

/** The body of the active tab, or the empty workspace when there is none. */
function TabBody({
  sourceId,
  onOpenQuery,
  queryRef,
}: {
  sourceId: string;
  onOpenQuery(): void;
  queryRef: RefObject<QueryTabHandle | null>;
}) {
  const tabs = useDatabaseStore((state) => state.tabs);
  const active = useDatabaseStore((state) => state.active);
  const pageSize = useDatabaseStore((state) => state.settings.tablePageSize);
  const setTablePageSize = useDatabaseStore((state) => state.setTablePageSize);
  const tab = tabs.find((entry) => tabKey(entry) === active);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!tab ? (
        <EmptyWorkspace onOpenQuery={onOpenQuery} />
      ) : tab.kind === "query" ? (
        <QueryTab ref={queryRef} sourceId={sourceId} tabKey={tabKey(tab)} file={tab.file} />
      ) : (
        <TableEditor
          target={tab.target}
          schema={tab.schema}
          table={tab.table}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setTablePageSize(size).catch((error: unknown) => toast.error(failureText(error)));
          }}
        />
      )}
    </div>
  );
}

/** The two columns of a window that has a data source to work against. */
function DatabaseWorkspace({ sourceId, root }: { sourceId: string; root: string }) {
  const { t } = useAppTranslation();

  const [source, setSource] = useState<DataSourceView | null>(null);
  const [listed, setListed] = useState(false);
  const [hasProject, setHasProject] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [openQueryOpen, setOpenQueryOpen] = useState(false);
  const [quickDoc, setQuickDoc] = useState<{ target: string; object: DbObjectRef } | null>(null);
  const [pendingInsert, setPendingInsert] = useState<string | null>(null);
  const treeRef = useRef<ObjectTreeHandle>(null);
  const queryRef = useRef<QueryTabHandle>(null);

  const hydrate = useDatabaseStore((state) => state.hydrate);
  const hydrated = useDatabaseStore((state) => state.hydrated);
  const connect = useDatabaseStore((state) => state.connect);
  const disconnect = useDatabaseStore((state) => state.disconnect);
  const close = useDatabaseStore((state) => state.close);
  const active = useDatabaseStore((state) => state.active);
  const tabs = useDatabaseStore((state) => state.tabs);
  const select = useDatabaseStore((state) => state.select);
  const openTable = useDatabaseStore((state) => state.openTable);
  const openQueryFile = useDatabaseStore((state) => state.openQuery);
  const connected = useDatabaseStore((state) => state.connection.status === "connected");
  const newQuery = useNewQuery();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Once the stored tabs are back the window connects on its own: a saved
  // password goes straight through, a missing one raises the prompt. The guard
  // keeps a later manual disconnect from being undone by this effect.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (!hydrated || autoConnected.current) return;
    autoConnected.current = true;
    void connect();
  }, [hydrated, connect]);

  const loadSources = useCallback(async () => {
    const list = await dbSourceList();
    setSource(list.find((entry) => entry.id === sourceId) ?? null);
    setHasProject(Boolean(root));
  }, [root, sourceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await dbSourceList();
        if (!cancelled) {
          setSource(list.find((entry) => entry.id === sourceId) ?? null);
          setHasProject(Boolean(root));
        }
      } catch {
        // Without the record the tree has nothing to render; the tabs still work.
        if (!cancelled) setSource(null);
      } finally {
        if (!cancelled) setListed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, sourceId]);

  const saveSource = useCallback(
    async (next: DataSource, password: string) => {
      try {
        const stored = (await dbSourceList()).map(asSource);
        const exists = stored.some((entry) => entry.id === next.id);
        await dbSourceSave(
          exists ? stored.map((entry) => (entry.id === next.id ? next : entry)) : [...stored, next]
        );
        if (password) {
          await dbSourceSetPassword(next.id, password, next.savePassword);
        }
        await loadSources();
      } catch (failure) {
        toast.error(failureText(failure));
        throw failure;
      }
    },
    [loadSources]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== "t" && key !== "w") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      if (key === "t") newQuery();
      else if (active) close(active);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, close, newQuery]);

  const jumpToConsole = () => {
    const query = tabs.find((tab) => tab.kind === "query");
    if (query) select(tabKey(query));
    else newQuery();
  };

  const editData = () => {
    if (!selection) return;
    if (selection.kind !== "table" && selection.kind !== "view") return;
    openTable(selection.target, selection.schema, selection.name);
  };

  const showDdl = () => {
    if (!selection) return;
    setQuickDoc({ target: selection.target, object: selection.object });
  };

  /** Appends SQL the tree generated; a table of another database is refused. */
  const insertSql = useCallback(
    (target: string, sql: string) => {
      if (target !== sourceId) {
        toast.info(t("database.tree.otherDatabase"));
        return;
      }
      if (queryRef.current) {
        queryRef.current.insertSql(sql);
        return;
      }
      // No query tab is mounted: open one and hand the statement over once the
      // editor of the new tab exists.
      setPendingInsert(sql);
      openQueryFile().catch((failure: unknown) => {
        setPendingInsert(null);
        toast.error(failureText(failure));
      });
    },
    [openQueryFile, sourceId, t]
  );

  useEffect(() => {
    if (!pendingInsert || !queryRef.current) return;
    queryRef.current.insertSql(pendingInsert);
    setPendingInsert(null);
  }, [pendingInsert, active]);

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn("w-72 shrink-0 flex-col border-r md:flex", treeOpen ? "flex" : "hidden")}
        >
          <ConnectionBar />
          <TreeToolbar
            disabled={!connected}
            connected={connected}
            onNewQuery={newQuery}
            onOpenQuery={() => setOpenQueryOpen(true)}
            onNewTable={() => treeRef.current?.newTable()}
            onProperties={() => setPropertiesOpen(true)}
            onRefresh={() => treeRef.current?.refresh()}
            onDisconnect={() => void disconnect()}
            onJumpToConsole={jumpToConsole}
            onEditData={editData}
            onShowDdl={showDdl}
            canEditData={selection?.kind === "table" || selection?.kind === "view"}
            canShowDdl={selection !== null}
          />
          {source ? (
            <ObjectTree
              ref={treeRef}
              source={source}
              enabled={connected}
              onInsertSelect={insertSql}
              onOpenTable={openTable}
              onSelect={setSelection}
              onDisconnect={() => void disconnect()}
              onShowDdl={(target, _schema, object) => setQuickDoc({ target, object })}
              onQuickDoc={(target, object) => setQuickDoc({ target, object })}
              onNewQuery={newQuery}
              onJumpToConsole={jumpToConsole}
            />
          ) : (
            <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-3 text-center text-xs">
              {listed ? (
                t("database.window.missingTitle")
              ) : (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("database.loading")}
                </>
              )}
            </div>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center border-b px-1 py-1 md:hidden">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("database.tree.title")}
              aria-expanded={treeOpen}
              title={t("database.tree.title")}
              onClick={() => setTreeOpen((open) => !open)}
            >
              <PanelLeft />
            </Button>
          </div>
          <TabBar onOpenQuery={() => setOpenQueryOpen(true)} />
          <TabBody
            sourceId={sourceId}
            onOpenQuery={() => setOpenQueryOpen(true)}
            queryRef={queryRef}
          />
        </div>
      </div>

      <PasswordDialog />
      <OpenQueryDialog open={openQueryOpen} onOpenChange={setOpenQueryOpen} />
      {source && (
        <SourceDialog
          open={propertiesOpen}
          source={source}
          hasProject={hasProject}
          onOpenChange={setPropertiesOpen}
          onSaved={saveSource}
        />
      )}
      {quickDoc && (
        <QuickDoc
          open
          target={quickDoc.target}
          object={quickDoc.object}
          onOpenChange={(open) => {
            if (!open) setQuickDoc(null);
          }}
        />
      )}
    </>
  );
}

/**
 * A data source window. It is its own window and draws its own frame
 * (`WindowFrame` + `TitleBar`), and the data source it shows comes from
 * `?source=`. Without one there is nothing to connect to, so it says so rather
 * than guessing at a data source.
 *
 * Everything below the frame belongs to one store instance, rebuilt when the
 * data source changes, so two windows on two sources never share a tab.
 */
export default function DatabaseWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const sourceId = useMemo(() => sourceFromUrl(search), [search]);
  const root = useMemo(() => rootFromUrl(search), [search]);
  // The store's first commands read the active project from the command
  // context, so the children only mount once it is set.
  const [rootReady, setRootReady] = useState(false);

  useEffect(() => {
    if (root) {
      setActiveProject(root);
      setRootReady(true);
      return;
    }
    // A window opened by hand has no root in its URL; the app-wide active
    // project is the best answer, and `null` still lets app-wide sources work.
    let cancelled = false;
    void projectActive()
      .then((active) => {
        if (cancelled) return;
        if (active) setActiveProject(active);
        setRootReady(true);
      })
      .catch(() => {
        if (!cancelled) setRootReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  return (
    <WindowFrame
      titleBar={
        <TitleBar title={t("database.title")} showPin showMaximize closeOnEscape={!sourceId} />
      }
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      {sourceId && rootReady ? (
        <DatabaseStoreProvider sourceId={sourceId}>
          <DatabaseWorkspace sourceId={sourceId} root={root} />
        </DatabaseStoreProvider>
      ) : sourceId ? null : (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
          <Database className="size-8" />
          <p className="text-foreground font-medium">{t("database.window.missingTitle")}</p>
          <p className="max-w-md text-xs">{t("database.window.missingDescription")}</p>
        </div>
      )}
    </WindowFrame>
  );
}
