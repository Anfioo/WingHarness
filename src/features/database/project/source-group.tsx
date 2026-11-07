// One data source of the project panel: its header (status, actions) and, while
// expanded, its object tree.
//
// The tree is the database window's own `ObjectTree` with its title bar turned
// off: every command it calls routes by the `whp-` id, so it reads the project
// manager without knowing it. The connection is lazy — expanding the group is
// what connects, and disconnecting leaves the tree in place for a reconnect.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { DataSourceView } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ObjectTree, type ObjectTreeHandle } from "@/pages/database/object-tree";
import { QuickDoc } from "@/pages/database/quick-doc";
import type { DbObjectRef } from "@/pages/database/object-sql";
import { connectionOf, isSqlTab, useProjectDb } from "@/features/database/project/view-store";
import { sourceColorDot, sourceSummary } from "@/features/database/project/source-actions";

export type SourceGroupProps = {
  source: DataSourceView;
  expanded: boolean;
  onToggle(): void;
  onEdit(): void;
  onDuplicate(): void;
  onDelete(): void;
  onNewQuery(): void;
  onOpenQuery(): void;
};

/** A failure as text: the backend's message is already localized where it has a code. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SourceGroup(props: SourceGroupProps): ReactNode {
  const { source, expanded, onToggle, onEdit, onDuplicate, onDelete, onNewQuery, onOpenQuery } =
    props;
  const { t } = useAppTranslation();

  const connections = useProjectDb((state) => state.connections);
  const connect = useProjectDb((state) => state.connect);
  const disconnect = useProjectDb((state) => state.disconnect);
  const openTable = useProjectDb((state) => state.openTable);
  const appendSql = useProjectDb((state) => state.appendSql);

  const connection = connectionOf(connections, source.id);
  const connected = connection.status === "connected";
  const connecting = connection.status === "connecting";
  const failed = connection.status === "error";

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [quickDoc, setQuickDoc] = useState<{ target: string; object: DbObjectRef } | null>(null);
  const treeRef = useRef<ObjectTreeHandle>(null);
  /** The last attempt already raised the prompt; a cancel must not reopen it. */
  const prompted = useRef(false);

  useEffect(() => {
    if (!connection.needsPassword) {
      prompted.current = false;
      return;
    }
    if (prompted.current) return;
    prompted.current = true;
    setPassword("");
    setPasswordOpen(true);
  }, [connection.needsPassword]);

  // Expanding is what opens the connection; a collapsed group keeps its pool so
  // a reopen is instant and a manual disconnect stays a deliberate action.
  useEffect(() => {
    if (!expanded) return;
    if (connection.status !== "idle") return;
    connect(source.id).catch((error: unknown) => toast.error(failureText(error)));
    // `connection.status` is read at expand time on purpose; the store notifies
    // through the same subscription the panel already holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, source.id]);

  /** IDEA's "Jump to Query Console": focus this source's query tab, creating one if none is open. */
  const jumpToConsole = () => {
    const state = useProjectDb.getState();
    const open = state.tabs.find((tab) => isSqlTab(tab) && tab.sourceId === source.id);
    if (open) {
      state.select(open.id);
      return;
    }
    state.openQuery(source.id).catch((error: unknown) => toast.error(failureText(error)));
  };

  const toggleConnection = () => {
    const action = connected
      ? disconnect(source.id)
      : connect(source.id).then((state) => {
          if (state.needsPassword) {
            setPassword("");
            setPasswordOpen(true);
          }
        });
    action.catch((error: unknown) => toast.error(failureText(error)));
  };

  const submitPassword = () => {
    const typed = password;
    setPasswordOpen(false);
    setPassword("");
    connect(source.id, typed).catch((error: unknown) => toast.error(failureText(error)));
  };

  const status = connected
    ? t("projectDb.source.connected")
    : connecting
      ? t("projectDb.source.connecting")
      : failed
        ? t("projectDb.source.error")
        : t("projectDb.source.disconnected");

  return (
    <div className="border-b">
      <div className="flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          className="hover:bg-accent/60 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-left"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: sourceColorDot(source) }}
            aria-hidden
          />
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
            title={sourceSummary(source)}
          >
            {source.name}
          </span>
          <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[10px]">
            {t(`database.driver.${source.driver}`)}
          </span>
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
        </button>

        <Button
          variant="ghost"
          size="icon-xs"
          disabled={connecting}
          aria-label={connected ? t("projectDb.source.disconnect") : t("projectDb.source.connect")}
          title={connected ? t("projectDb.source.disconnect") : t("projectDb.source.connect")}
          onClick={toggleConnection}
        >
          {connecting ? <Loader2 className="animate-spin" /> : connected ? <Plug /> : <PlugZap />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("projectDb.source.actions")}
              title={t("projectDb.source.actions")}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onNewQuery}>
              <Plus />
              {t("projectDb.source.newQuery")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenQuery}>
              <FolderOpen />
              {t("projectDb.source.openQuery")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!connected} onSelect={() => treeRef.current?.refresh()}>
              <RefreshCw />
              {t("projectDb.source.refresh")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil />
              {t("projectDb.source.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>
              <Copy />
              {t("projectDb.source.duplicate")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 />
              {t("projectDb.source.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && (
        <div className="max-h-[45vh] min-h-0 overflow-auto">
          {failed && connection.error && (
            <p className="text-destructive px-3 py-1 text-[11px] break-words">{connection.error}</p>
          )}
          <ObjectTree
            ref={treeRef}
            source={source}
            enabled={connected}
            showHeader={false}
            onInsertSelect={(target, sql) => {
              const sourceId = target.split(":")[0];
              appendSql(sourceId, sql).catch((error: unknown) => toast.error(failureText(error)));
            }}
            onOpenTable={(target, schema, table) => {
              openTable(target.split(":")[0], target, schema, table);
            }}
            onDisconnect={() => {
              disconnect(source.id).catch((error: unknown) => toast.error(failureText(error)));
            }}
            onShowDdl={(target, _schema, object) => setQuickDoc({ target, object })}
            onQuickDoc={(target, object) => setQuickDoc({ target, object })}
            onNewQuery={onNewQuery}
            onJumpToConsole={jumpToConsole}
          />
        </div>
      )}

      <Dialog
        open={passwordOpen}
        onOpenChange={(next) => {
          setPasswordOpen(next);
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
              submitPassword();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`project-db-password-${source.id}`} className="text-xs">
                {t("database.console.passwordLabel")}
              </Label>
              <Input
                id={`project-db-password-${source.id}`}
                type="password"
                value={password}
                autoComplete="current-password"
                autoFocus
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPasswordOpen(false)}
              >
                {t("database.form.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={connecting}>
                {connecting ? <Loader2 className="animate-spin" /> : <PlugZap />}
                {t("database.console.passwordSubmit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
    </div>
  );
}
