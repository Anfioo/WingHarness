import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { frpTunnelDelete, frpTunnelUpdate } from "@/commands/services/frp";
import type { Tunnel, TunnelInput, TunnelState, TunnelView } from "@/commands/services/frp/types";
import { isActiveProcessState, StateBadge } from "@/components/frp/state-badge";
import { TunnelFormDialog } from "@/components/frp/tunnel-form-dialog";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { SnapshotMap } from "@/hooks/use-frp-events";
import type { FrpWorkspace } from "@/hooks/use-frp-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatEndpoint, formatPublicAddress } from "@/lib/frp/format";
import { cn } from "@/lib/utils";

const ALL_SERVERS = "all";

export type TunnelsTabProps = {
  workspace: FrpWorkspace;
  /** Switches to the servers tab; the empty state uses it when none exists. */
  onOpenServers?: () => void;
};

/**
 * A process that is not running cannot have live tunnel state, so every tunnel
 * of such a profile reads as offline. Otherwise the merged snapshot decides.
 */
function tunnelStateOf(tunnel: TunnelView, snapshots: SnapshotMap): TunnelState {
  const snapshot = snapshots[tunnel.profileId];
  if (!snapshot || snapshot.state !== "running") return "offline";
  return snapshot.tunnelStates.find((entry) => entry.name === tunnel.name)?.state ?? "offline";
}

/** Re-sends a tunnel with only `enabled` flipped, as the inline switch does. */
function toInput(tunnel: TunnelView, enabled: boolean): TunnelInput {
  return {
    profileId: tunnel.profileId,
    name: tunnel.name,
    type: tunnel.type,
    enabled,
    localIp: tunnel.localIp,
    localPort: tunnel.localPort,
    options: tunnel.options,
  };
}

type TunnelDeleteDialogProps = {
  tunnel: TunnelView | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

function TunnelDeleteDialog({ tunnel, busy, onOpenChange, onConfirm }: TunnelDeleteDialogProps) {
  const { t } = useAppTranslation();

  return (
    <Dialog open={tunnel !== null} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("frp.tunnels.delete.title")}</DialogTitle>
          <DialogDescription>{t("frp.tunnels.delete.description")}</DialogDescription>
        </DialogHeader>
        {tunnel && <p className="text-sm font-medium break-all">{tunnel.name}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("frp.common.cancel")}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t("frp.common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The all-profiles tunnel table: filter, search and inline enable toggle.
 * A row opens the edit dialog; the enable switch only sends `enabled`, so it
 * never has to round-trip the rest of the form.
 */
export function TunnelsTab({ workspace, onOpenServers }: TunnelsTabProps) {
  const { t } = useAppTranslation();
  const { profiles, tunnels, snapshots, loading, reload, runAction } = workspace;

  const [serverFilter, setServerFilter] = useState(ALL_SERVERS);
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TunnelView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TunnelView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const profileById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tunnels.filter((tunnel) => {
      if (serverFilter !== ALL_SERVERS && tunnel.profileId !== serverFilter) return false;
      if (!needle) return true;
      return (
        tunnel.name.toLowerCase().includes(needle) ||
        tunnel.profileName.toLowerCase().includes(needle)
      );
    });
  }, [tunnels, serverFilter, query]);

  // A running profile whose generated config no longer matches the saved one
  // keeps serving the old tunnels until it restarts.
  const restartingServers = useMemo(() => {
    const names: string[] = [];
    for (const profile of profiles) {
      const snapshot = snapshots[profile.id];
      if (!snapshot) continue;
      if (!isActiveProcessState(snapshot.state)) continue;
      if (snapshot.configRevision !== profile.configRevision) names.push(profile.name);
    }
    return names;
  }, [profiles, snapshots]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (tunnel: TunnelView) => {
    setEditing(tunnel);
    setFormOpen(true);
  };

  const handleSaved = async (saved: Tunnel) => {
    const created = editing === null;
    const wasRunning = isActiveProcessState(snapshots[saved.profileId]?.state);
    await reload();
    toast.success(created ? t("frp.tunnelForm.created") : t("frp.tunnelForm.updated"));
    if (wasRunning) toast.info(t("frp.tunnel.restartToApply"));
  };

  const toggleEnabled = async (tunnel: TunnelView, enabled: boolean) => {
    setBusyId(tunnel.id);
    try {
      await runAction(() => frpTunnelUpdate(tunnel.id, toInput(tunnel, enabled)));
      await reload();
    } catch {
      toast.error(t("frp.tunnels.updateFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await runAction(() => frpTunnelDelete(deleteTarget.id));
      await reload();
      setDeleteTarget(null);
      toast.success(t("frp.tunnels.deleted"));
    } catch {
      // `runAction` already wrote the failure to the page-level error banner.
    } finally {
      setBusyId(null);
    }
  };

  const deleting = deleteTarget !== null && busyId === deleteTarget.id;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={serverFilter} onValueChange={(value) => setServerFilter(value)}>
          <SelectTrigger className="w-44" aria-label={t("frp.tunnels.col.server")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SERVERS}>{t("frp.tunnels.allServers")}</SelectItem>
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative min-w-48 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            className="pl-8"
            placeholder={t("frp.tunnels.search.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <Button variant="outline" size="sm" disabled={loading} onClick={() => void reload()}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {t("frp.common.refresh")}
        </Button>

        <Button size="sm" disabled={profiles.length === 0} onClick={openCreate}>
          <Plus />
          {t("frp.tunnels.action.create")}
        </Button>
      </div>

      {restartingServers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{t("frp.tunnel.restartToApply")}</span>
          <span className="min-w-0 truncate font-medium">{restartingServers.join(", ")}</span>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <Network className="size-8" />
          <p className="text-foreground font-medium">{t("frp.tunnels.empty.title")}</p>
          <p className="max-w-md">{t("frp.tunnels.empty.noServer")}</p>
          {onOpenServers && (
            <Button size="sm" onClick={onOpenServers}>
              <Plus />
              {t("frp.servers.action.create")}
            </Button>
          )}
        </div>
      ) : tunnels.length === 0 ? (
        <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <Network className="size-8" />
          <p className="text-foreground font-medium">{t("frp.tunnels.empty.title")}</p>
          <p className="max-w-md">{t("frp.tunnels.empty.description")}</p>
          <Button size="sm" onClick={openCreate}>
            <Plus />
            {t("frp.tunnels.action.create")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t("frp.tunnels.list.noResults")}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {t("frp.tunnels.list.count", { count: filtered.length })}
          </p>

          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("frp.tunnels.col.name")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("frp.tunnels.col.server")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("frp.tunnels.col.type")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("frp.tunnels.col.local")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("frp.tunnels.col.public")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("frp.tunnels.col.status")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t("frp.tunnels.col.enabled")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t("frp.tunnels.col.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tunnel) => {
                  const profile = profileById.get(tunnel.profileId) ?? null;
                  const publicAddress = profile
                    ? formatPublicAddress(tunnel, profile.serverAddr)
                    : null;
                  const busy = busyId === tunnel.id;

                  return (
                    <tr
                      key={tunnel.id}
                      className="border-border hover:bg-muted/40 cursor-pointer border-t transition-colors"
                      onClick={() => openEdit(tunnel)}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className={cn(
                              "text-left font-medium hover:underline",
                              !tunnel.enabled && "text-muted-foreground"
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              openEdit(tunnel);
                            }}
                          >
                            {tunnel.name}
                          </button>
                          {busy && <Loader2 className="size-3 animate-spin" />}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className="block max-w-40 truncate">
                          {tunnel.profileName || profile?.name || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="secondary">{tunnel.type.toUpperCase()}</Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {formatEndpoint(tunnel.localIp, tunnel.localPort)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <span
                          className="block max-w-48 truncate"
                          title={publicAddress ?? undefined}
                        >
                          {publicAddress ?? "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <StateBadge state={tunnelStateOf(tunnel, snapshots)} />
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <Switch
                            checked={tunnel.enabled}
                            disabled={busy}
                            aria-label={`${t("frp.tunnels.col.enabled")}: ${tunnel.name}`}
                            onCheckedChange={(next) => void toggleEnabled(tunnel, next)}
                          />
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div
                          className="flex items-center justify-end gap-1"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("frp.common.edit")}
                            title={t("frp.common.edit")}
                            disabled={busy}
                            onClick={() => openEdit(tunnel)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("frp.common.delete")}
                            title={t("frp.common.delete")}
                            disabled={busy}
                            onClick={() => setDeleteTarget(tunnel)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <TunnelFormDialog
        open={formOpen}
        tunnel={editing}
        profiles={profiles}
        tunnels={tunnels}
        defaultProfileId={serverFilter === ALL_SERVERS ? null : serverFilter}
        onOpenChange={(next) => {
          setFormOpen(next);
          if (!next) setEditing(null);
        }}
        onSaved={(saved) => void handleSaved(saved)}
      />

      <TunnelDeleteDialog
        tunnel={deleteTarget}
        busy={deleting}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
