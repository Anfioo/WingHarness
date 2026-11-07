// The shell of a data source window: the object tree on the left, the tab strip
// and the active tab on the right.
//
// Tab state lives in the window store and nowhere else; this file only lays the
// store out and owns the two things the store cannot hold: the data source
// record the tree renders, and the password prompt.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { dbSourceList, type DataSourceView } from "@/commands";
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
import { ObjectTree } from "./object-tree";
import { QueryTab } from "./query-tab";
import { DatabaseStoreProvider, tabKey, useDatabaseStore } from "./store";
import { TabBar } from "./tab-bar";
import { TableEditor } from "./table-editor";
import { TreeToolbar } from "./tree-toolbar";
// ObjectTree still reads the legacy tab context. F4 rewires it to the store in
// W2; this provider and window-tabs.tsx go at the same time.
import { DatabaseTabsProvider } from "./window-tabs";

/** The data source this window was opened for, taken from its own URL. */
function sourceFromUrl(search: string) {
  return new URLSearchParams(search).get("source") ?? "";
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

/**
 * The tree actions that need a selected node, and the insert-a-SELECT target
 * that needs an editor. F4 and F6 own both; nothing here can answer them yet.
 */
const deferred = () => {};

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
function EmptyWorkspace() {
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
        {/* Until the tree toolbar's "Open query…" picker lands, this creates a
            file too rather than sitting there dead. */}
        <Button variant="outline" size="sm" onClick={newQuery}>
          <FolderOpen />
          {t("database.workspace.openQuery")}
        </Button>
      </div>
    </div>
  );
}

/** The body of the active tab, or the empty workspace when there is none. */
function TabBody({ sourceId }: { sourceId: string }) {
  const tabs = useDatabaseStore((state) => state.tabs);
  const active = useDatabaseStore((state) => state.active);
  const tab = tabs.find((entry) => tabKey(entry) === active);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!tab ? (
        <EmptyWorkspace />
      ) : tab.kind === "query" ? (
        <QueryTab sourceId={sourceId} tabKey={tabKey(tab)} file={tab.file} />
      ) : (
        <TableEditor target={tab.target} schema={tab.schema} table={tab.table} />
      )}
    </div>
  );
}

/** The two columns of a window that has a data source to work against. */
function DatabaseWorkspace({ sourceId }: { sourceId: string }) {
  const { t } = useAppTranslation();

  const [source, setSource] = useState<DataSourceView | null>(null);
  const [listed, setListed] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);

  const hydrate = useDatabaseStore((state) => state.hydrate);
  const hydrated = useDatabaseStore((state) => state.hydrated);
  const connect = useDatabaseStore((state) => state.connect);
  const disconnect = useDatabaseStore((state) => state.disconnect);
  const close = useDatabaseStore((state) => state.close);
  const active = useDatabaseStore((state) => state.active);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await dbSourceList();
        if (!cancelled) setSource(list.find((entry) => entry.id === sourceId) ?? null);
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
  }, [sourceId]);

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
            onOpenQuery={newQuery}
            onNewTable={deferred}
            onProperties={deferred}
            onRefresh={deferred}
            onDisconnect={() => void disconnect()}
            onJumpToConsole={deferred}
            onEditData={deferred}
            onShowDdl={deferred}
            canEditData={false}
            canShowDdl={false}
          />
          {source ? (
            <DatabaseTabsProvider sourceId={sourceId}>
              <ObjectTree source={source} enabled={connected} onInsertSelect={deferred} />
            </DatabaseTabsProvider>
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
          <TabBar />
          <TabBody sourceId={sourceId} />
        </div>
      </div>

      <PasswordDialog />
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

  return (
    <WindowFrame
      titleBar={
        <TitleBar title={t("database.title")} showPin showMaximize closeOnEscape={!sourceId} />
      }
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      {sourceId ? (
        <DatabaseStoreProvider sourceId={sourceId}>
          <DatabaseWorkspace sourceId={sourceId} />
        </DatabaseStoreProvider>
      ) : (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
          <Database className="size-8" />
          <p className="text-foreground font-medium">{t("database.window.missingTitle")}</p>
          <p className="max-w-md text-xs">{t("database.window.missingDescription")}</p>
        </div>
      )}
    </WindowFrame>
  );
}
