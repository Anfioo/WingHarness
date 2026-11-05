import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Ban, PowerOff, RefreshCw, Unplug, X } from "lucide-react";
import { toast } from "sonner";
import {
  clashConnectionClose,
  clashConnections,
  clashConnectionsCloseAll,
  type ClashConnection,
  type ClashConnectionsView,
} from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Empty, IconButton, formatBytes } from "./shared";

/** The core pushes nothing, so the page asks. Two seconds is the pace the
 *  official dashboard uses and is cheap enough to leave running. */
const POLL_MS = 2000;

export function ConnectionsTab({ running }: { running: boolean }) {
  const { t } = useAppTranslation();

  const [view, setView] = useState<ClashConnectionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await clashConnections();
      if (!mounted.current) return;
      setView(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setView(null);
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const close = useCallback(
    async (connection: ClashConnection) => {
      try {
        await clashConnectionClose(connection.id);
        await load();
      } catch (cause) {
        toast.error(String(cause));
      }
    },
    [load]
  );

  const closeAll = useCallback(async () => {
    setBusy(true);
    try {
      await clashConnectionsCloseAll();
      setConfirmCloseAll(false);
      toast.success(t("clash.conn.closedAll"));
      await load();
    } catch (cause) {
      toast.error(String(cause));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  const connections = view?.connections ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="bg-muted/60 text-muted-foreground flex items-center gap-1 rounded px-1.5 py-0.5 font-mono tabular-nums">
          <ArrowUp className="size-3.5" />
          {formatBytes(view?.uploadTotal ?? 0)}
        </span>
        <span className="bg-muted/60 text-muted-foreground flex items-center gap-1 rounded px-1.5 py-0.5 font-mono tabular-nums">
          <ArrowDown className="size-3.5" />
          {formatBytes(view?.downloadTotal ?? 0)}
        </span>
        <span className="text-muted-foreground">
          {t("clash.conn.count", { count: connections.length })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            {t("clash.actions.refresh")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || connections.length === 0}
            onClick={() => setConfirmCloseAll(true)}
          >
            <Ban className="size-3.5" />
            {t("clash.conn.closeAll")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <Empty icon={PowerOff} text={running ? error : t("clash.conn.offline")} />
        ) : connections.length === 0 ? (
          <Empty icon={Unplug} text={t("clash.conn.empty")} />
        ) : (
          connections.map((connection) => (
            <div
              key={connection.id}
              className="hover:bg-accent/40 flex items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {connection.host || connection.destination || connection.rulePayload || "—"}
                </div>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                  {connection.kind && <span>{connection.kind}</span>}
                  {connection.network && <span>{connection.network}</span>}
                  {connection.chains.length > 0 && (
                    <span className="truncate font-mono">{connection.chains.join(" → ")}</span>
                  )}
                  {connection.rule && (
                    <span>
                      {connection.rule}
                      {connection.rulePayload ? `(${connection.rulePayload})` : ""}
                    </span>
                  )}
                  {connection.destination && (
                    <span className="font-mono">{connection.destination}</span>
                  )}
                </div>
              </div>
              <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
                ↑{formatBytes(connection.upload)} ↓{formatBytes(connection.download)}
              </span>
              <IconButton title={t("clash.conn.close")} onClick={() => void close(connection)}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          ))
        )}
      </div>

      <Dialog open={confirmCloseAll} onOpenChange={setConfirmCloseAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clash.conn.closeAll")}</DialogTitle>
            <DialogDescription>{t("clash.conn.confirmCloseAll")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCloseAll(false)}>
              {t("clash.prompts.cancel")}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void closeAll()}>
              {t("clash.prompts.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
