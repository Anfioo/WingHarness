// The right-click menu of one connection: reveal its process, end that
// process, reset an established IPv4 TCP connection, and copy an endpoint.

import { ArrowUpRight, Copy, ShieldAlert, Skull, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { Connection, ProcessRow } from "@/commands";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { connectionEndpoint } from "@/hooks/use-task-manager-connections";

export function ConnectionsContextMenu({
  connection,
  process,
  serviceReady,
  onReveal,
  onKill,
  onClose,
  children,
}: {
  connection: Connection;
  process: ProcessRow | undefined;
  serviceReady: boolean;
  onReveal: (connection: Connection) => void;
  onKill: (connection: Connection, process: ProcessRow) => void;
  onClose: (connection: Connection) => void;
  children: React.ReactNode;
}) {
  const { t } = useAppTranslation();
  const closable =
    connection.protocol === "tcp" && !connection.ipv6 && connection.state === "established";
  const closeHint = !closable
    ? t("taskManager.connections.hints.closeUnsupported")
    : !serviceReady
      ? t("taskManager.connections.hints.closeNeedsService")
      : null;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("taskManager.connections.toast.endpointCopied"));
    } catch {
      toast.error(t("taskManager.connections.toast.copyFailed"));
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuItem onSelect={() => onReveal(connection)}>
          <ArrowUpRight />
          {t("taskManager.connections.actions.gotoProcess")}
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          disabled={!process || connection.pid <= 4}
          onSelect={() => {
            if (process) onKill(connection, process);
          }}
        >
          <Skull />
          {t("taskManager.connections.actions.killProcess")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!closable || !serviceReady} onSelect={() => onClose(connection)}>
          <XCircle />
          {t("taskManager.connections.actions.close")}
        </ContextMenuItem>

        {(closeHint || !process) && (
          <ContextMenuLabel className="text-muted-foreground flex items-start gap-2 text-xs font-normal">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="whitespace-normal">
              {closeHint ?? t("taskManager.connections.hints.processExited")}
            </span>
          </ContextMenuLabel>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem
          onSelect={() =>
            void copy(
              connectionEndpoint(connection.localAddress, connection.localPort, connection.ipv6)
            )
          }
        >
          <Copy />
          {t("taskManager.connections.actions.copyLocal")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={connection.remoteAddress === null}
          onSelect={() => {
            if (connection.remoteAddress === null) return;
            void copy(
              connectionEndpoint(connection.remoteAddress, connection.remotePort, connection.ipv6)
            );
          }}
        >
          <Copy />
          {t("taskManager.connections.actions.copyRemote")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
