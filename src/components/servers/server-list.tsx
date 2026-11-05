import {
  ArrowDown,
  ArrowUp,
  Copy,
  Loader2,
  Pencil,
  Server,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { ConnectionState, ServerProfile } from "@/commands/services/servers/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatEndpoint, formatRelativeTime } from "@/lib/servers/format";
import { cn } from "@/lib/utils";

const STATE_DOT: Record<ConnectionState, string> = {
  idle: "bg-muted-foreground/50",
  connecting: "bg-amber-500 animate-pulse",
  ready: "bg-emerald-500",
  failed: "bg-destructive",
};

const STATE_TEXT: Record<ConnectionState, string> = {
  idle: "text-muted-foreground",
  connecting: "text-amber-600 dark:text-amber-400",
  ready: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
};

export type ServerListProps = {
  profiles: ServerProfile[];
  /** Ids in saved order, used for move boundaries when `profiles` is filtered. */
  orderIds: string[];
  /** Live connection state per profile id; missing entries read as `idle`. */
  states: Record<string, ConnectionState>;
  /** Millisecond clock used for the "last connected" labels. */
  now: number;
  /** Profile id with a list-level operation in flight, if any. */
  busyId: string | null;
  onOpen: (profile: ServerProfile) => void;
  onEdit: (profile: ServerProfile) => void;
  onDuplicate: (profile: ServerProfile) => void;
  onDelete: (profile: ServerProfile) => void;
  onMove: (profile: ServerProfile, direction: -1 | 1) => void;
};

/**
 * The saved-server rows. Purely presentational: search, persistence and the
 * confirm dialogs belong to the page, so the same rows can back a future
 * compact view without dragging command calls along.
 */
export function ServerList({
  profiles,
  orderIds,
  states,
  now,
  busyId,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
}: ServerListProps) {
  const { t, language } = useAppTranslation();

  return (
    <ul className="flex flex-col gap-2" role="list">
      {profiles.map((profile) => {
        const state = states[profile.id] ?? "idle";
        const lastConnected = formatRelativeTime(profile.lastConnectedAt, now, language);
        const busy = busyId === profile.id;
        // Move boundaries come from the unfiltered order so a search result
        // that is not first in the saved order keeps both arrows active.
        const orderIndex = orderIds.indexOf(profile.id);

        return (
          <li
            key={profile.id}
            tabIndex={0}
            className="group border-border bg-card hover:border-ring/40 hover:bg-accent/40 focus-visible:ring-ring/50 flex items-center gap-3 rounded-lg border p-3 transition-colors outline-none focus-visible:ring-[3px]"
            onDoubleClick={() => onOpen(profile)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onOpen(profile);
            }}
          >
            <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />}
            </span>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-foreground truncate text-sm font-medium">{profile.name}</span>
                <Badge variant="secondary">
                  {profile.authKind === "password"
                    ? t("servers.form.authPassword", { defaultValue: "Password" })
                    : t("servers.form.authKey", { defaultValue: "Private key" })}
                </Badge>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-[11px] font-medium",
                    STATE_TEXT[state]
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", STATE_DOT[state])} />
                  {t(`servers.connection.${state}`)}
                </span>
              </div>

              <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                <span className="truncate font-mono">
                  {formatEndpoint(profile.host, profile.port, profile.username)}
                </span>
                <span className="text-muted-foreground/60">·</span>
                <span className="truncate">
                  {lastConnected ??
                    t("servers.list.neverConnected", { defaultValue: "Never connected" })}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("servers.action.moveUp", { defaultValue: "Move up" })}
                title={t("servers.action.moveUp", { defaultValue: "Move up" })}
                disabled={busy || orderIndex <= 0}
                onClick={() => onMove(profile, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("servers.action.moveDown", { defaultValue: "Move down" })}
                title={t("servers.action.moveDown", { defaultValue: "Move down" })}
                disabled={busy || orderIndex === orderIds.length - 1}
                onClick={() => onMove(profile, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("servers.action.edit")}
                title={t("servers.action.edit")}
                disabled={busy}
                onClick={() => onEdit(profile)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("servers.action.duplicate")}
                title={t("servers.action.duplicate")}
                disabled={busy}
                onClick={() => onDuplicate(profile)}
              >
                <Copy />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("servers.action.delete")}
                title={t("servers.action.delete")}
                disabled={busy}
                onClick={() => onDelete(profile)}
              >
                <Trash2 />
              </Button>
              <Button
                size="sm"
                className="ml-1"
                disabled={busy}
                onClick={() => onOpen(profile)}
                title={t("servers.action.open")}
              >
                <SquareTerminal />
                {t("servers.action.open")}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
