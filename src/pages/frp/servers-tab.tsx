import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FileInput,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  frpProfileCreate,
  frpProfileDelete,
  frpProfileReorder,
  frpRestart,
  frpStart,
  frpStop,
} from "@/commands/services/frp";
import type { FrpProfile } from "@/commands/services/frp/types";
import { ConfigImportDialog } from "@/components/frp/config-import-dialog";
import { ServerDeleteDialog, ServerDetailDrawer } from "@/components/frp/server-detail-drawer";
import { ServerFormDialog } from "@/components/frp/server-form-dialog";
import { isActiveProcessState, StateBadge } from "@/components/frp/state-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FrpWorkspace } from "@/hooks/use-frp-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatEndpoint, formatLatency, formatVersion } from "@/lib/frp/format";
import { cn } from "@/lib/utils";

export type ServersTabProps = {
  workspace: FrpWorkspace;
  /** Switch to the logs tab with this profile preselected. */
  onOpenLogs: (profileId: string) => void;
  /** Switch to the runtime tab; used by the empty state. */
  onOpenRuntime: () => void;
};

/**
 * The saved server profiles: search, ordering and the start/stop/restart
 * actions. Live state comes from the workspace snapshot map; every mutation
 * reloads the workspace so the list stays the single source of truth.
 */
export function ServersTab({ workspace, onOpenLogs, onOpenRuntime }: ServersTabProps) {
  const { t } = useAppTranslation();
  const { profiles, runtimes, snapshots, tunnels, loading, reload, runAction } = workspace;

  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<FrpProfile | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const tunnelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tunnel of tunnels) {
      counts[tunnel.profileId] = (counts[tunnel.profileId] ?? 0) + 1;
    }
    return counts;
  }, [tunnels]);

  // The reordered list is shown immediately and discarded once the saved order
  // comes back (or when the command fails), so a slow reload never snaps back.
  const orderedProfiles = useMemo(() => {
    if (!pendingOrder) return profiles;
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const ordered: FrpProfile[] = [];
    for (const id of pendingOrder) {
      const profile = byId.get(id);
      if (profile) ordered.push(profile);
    }
    const seen = new Set(ordered.map((profile) => profile.id));
    for (const profile of profiles) {
      if (!seen.has(profile.id)) ordered.push(profile);
    }
    return ordered;
  }, [profiles, pendingOrder]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return orderedProfiles;
    return orderedProfiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(needle) ||
        profile.serverAddr.toLowerCase().includes(needle) ||
        formatEndpoint(profile.serverAddr, profile.serverPort).toLowerCase().includes(needle)
    );
  }, [orderedProfiles, query]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (profile: FrpProfile) => {
    setEditing(profile);
    setFormOpen(true);
  };

  const handleSaved = async () => {
    const created = editing === null;
    await reload();
    toast.success(created ? t("frp.serverForm.created") : t("frp.serverForm.updated"));
  };

  const runProfileAction = async (profileId: string, action: () => Promise<unknown>) => {
    setBusyId(profileId);
    try {
      await runAction(action);
      await reload();
    } catch {
      // `runAction` already wrote the failure to the page-level error banner.
    } finally {
      setBusyId(null);
    }
  };

  const move = async (profile: FrpProfile, direction: -1 | 1) => {
    const ids = orderedProfiles.map((entry) => entry.id);
    const index = ids.indexOf(profile.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;

    const next = [...ids];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);

    setPendingOrder(next);
    setBusyId(profile.id);
    try {
      await runAction(() => frpProfileReorder(next));
      await reload();
      setPendingOrder(null);
    } catch {
      setPendingOrder(null);
      toast.error(t("frp.servers.reorderFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (profile: FrpProfile) => {
    const base = `${profile.name} ${t("frp.servers.copySuffix")}`;
    const taken = new Set(profiles.map((entry) => entry.name.toLowerCase()));
    let name = base;
    let counter = 2;
    while (taken.has(name.toLowerCase())) {
      name = `${base} ${counter}`;
      counter += 1;
    }

    setBusyId(profile.id);
    try {
      await runAction(() =>
        frpProfileCreate({
          name,
          serverAddr: profile.serverAddr,
          serverPort: profile.serverPort,
          token: profile.token,
          runtimePolicy: profile.runtimePolicy,
          runtimeId: profile.runtimeId,
          reconnectEnabled: profile.reconnectEnabled,
          note: profile.note,
        })
      );
      await reload();
      toast.success(t("frp.servers.duplicated"));
    } catch {
      // The banner from `runAction` explains why the copy failed.
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const target = deleteId ? (profiles.find((entry) => entry.id === deleteId) ?? null) : null;
    if (!target) {
      setDeleteId(null);
      return;
    }

    setBusyId(target.id);
    try {
      await runAction(() => frpProfileDelete(target.id));
      await reload();
      setDeleteId(null);
      if (detailId === target.id) setDetailId(null);
      toast.success(t("frp.servers.deleted"));
    } catch {
      // The banner from `runAction` explains why the delete failed.
    } finally {
      setBusyId(null);
    }
  };

  const detailProfile = detailId
    ? (profiles.find((profile) => profile.id === detailId) ?? null)
    : null;
  const detailSnapshot = detailId ? (snapshots[detailId] ?? null) : null;
  const detailNeedsRestart =
    detailProfile !== null &&
    detailSnapshot !== null &&
    detailSnapshot.configRevision !== detailProfile.configRevision;

  const deleteProfile = deleteId
    ? (profiles.find((profile) => profile.id === deleteId) ?? null)
    : null;

  const runDetailAction = (action: (profileId: string) => Promise<unknown>) => {
    if (!detailProfile) return;
    void runProfileAction(detailProfile.id, () => action(detailProfile.id));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            className="pl-8"
            placeholder={t("frp.servers.search.placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void reload()}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {t("frp.common.refresh")}
        </Button>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => setImportOpen(true)}>
          <FileInput />
          {t("frp.import.action")}
        </Button>
        <Button size="sm" disabled={runtimes.length === 0} onClick={openCreate}>
          <Plus />
          {t("frp.servers.action.create")}
        </Button>
      </div>

      {profiles.length === 0 ? (
        <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <Server className="size-8" />
          <p className="text-foreground font-medium">{t("frp.servers.empty.title")}</p>
          <p className="max-w-md">
            {runtimes.length === 0
              ? t("frp.servers.empty.noRuntime")
              : t("frp.servers.empty.description")}
          </p>
          {runtimes.length === 0 ? (
            <Button size="sm" onClick={onOpenRuntime}>
              {t("frp.overview.noRuntime.action")}
            </Button>
          ) : (
            <Button size="sm" onClick={openCreate}>
              <Plus />
              {t("frp.servers.empty.action")}
            </Button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t("frp.servers.list.noResults")}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {t("frp.servers.list.count", { count: filtered.length })}
          </p>
          <ul className="flex flex-col gap-2" role="list">
            {filtered.map((profile) => {
              const snapshot = snapshots[profile.id] ?? null;
              const state = snapshot?.state ?? "stopped";
              const active = isActiveProcessState(state);
              const busy = busyId === profile.id;
              const needsRestart =
                snapshot !== null && snapshot.configRevision !== profile.configRevision;
              const orderIndex = orderedProfiles.findIndex((entry) => entry.id === profile.id);
              const pinnedRuntime =
                profile.runtimePolicy === "pinned" && profile.runtimeId
                  ? (runtimes.find((runtime) => runtime.id === profile.runtimeId) ?? null)
                  : null;
              const runtimeText = snapshot?.runtimeVersion
                ? formatVersion(snapshot.runtimeVersion)
                : profile.runtimePolicy === "pinned"
                  ? pinnedRuntime
                    ? formatVersion(pinnedRuntime.version)
                    : t("frp.servers.runtime.missing")
                  : t("frp.servers.runtime.recommended");
              const lastError = snapshot?.lastError?.trim();

              return (
                <li
                  key={profile.id}
                  className="border-border bg-card flex flex-wrap items-center gap-3 rounded-lg border p-3"
                >
                  <span
                    className={cn(
                      "bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-md",
                      busy && "opacity-80"
                    )}
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Server className="size-4" />
                    )}
                  </span>

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="text-foreground min-w-0 truncate text-sm font-medium hover:underline"
                        title={t("frp.servers.action.details")}
                        onClick={() => setDetailId(profile.id)}
                      >
                        {profile.name}
                      </button>
                      <StateBadge state={state} />
                      <Badge variant="outline">
                        {t("frp.servers.configRevision", { revision: profile.configRevision })}
                      </Badge>
                      {needsRestart && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 text-amber-700 dark:text-amber-400"
                        >
                          {t("frp.servers.badgeRestart")}
                        </Badge>
                      )}
                    </div>

                    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                      <span className="truncate font-mono">
                        {formatEndpoint(profile.serverAddr, profile.serverPort)}
                      </span>
                      <span>
                        {t("frp.servers.col.runtime")}: {runtimeText}
                      </span>
                      <span>
                        {t("frp.servers.col.latency")}:{" "}
                        <span className="tabular-nums">{formatLatency(snapshot?.latencyMs)}</span>
                      </span>
                      <span>
                        {t("frp.servers.col.tunnels")}:{" "}
                        <span className="tabular-nums">{tunnelCounts[profile.id] ?? 0}</span>
                      </span>
                    </div>

                    {lastError && (
                      <p className="text-destructive line-clamp-2 text-xs break-words">
                        {lastError}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.servers.action.moveUp")}
                      title={t("frp.servers.action.moveUp")}
                      disabled={busy || orderIndex <= 0}
                      onClick={() => void move(profile, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.servers.action.moveDown")}
                      title={t("frp.servers.action.moveDown")}
                      disabled={busy || orderIndex === orderedProfiles.length - 1}
                      onClick={() => void move(profile, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.common.start")}
                      title={t("frp.common.start")}
                      disabled={busy || active}
                      onClick={() => void runProfileAction(profile.id, () => frpStart(profile.id))}
                    >
                      <Play />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.common.stop")}
                      title={t("frp.common.stop")}
                      disabled={busy || !active}
                      onClick={() => void runProfileAction(profile.id, () => frpStop(profile.id))}
                    >
                      <Square />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.common.restart")}
                      title={t("frp.common.restart")}
                      disabled={busy}
                      onClick={() =>
                        void runProfileAction(profile.id, () => frpRestart(profile.id))
                      }
                    >
                      <RotateCw />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.common.edit")}
                      title={t("frp.common.edit")}
                      disabled={busy}
                      onClick={() => openEdit(profile)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.servers.action.duplicate")}
                      title={t("frp.servers.action.duplicate")}
                      disabled={busy}
                      onClick={() => void duplicate(profile)}
                    >
                      <Copy />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("frp.common.delete")}
                      title={t("frp.common.delete")}
                      disabled={busy}
                      onClick={() => setDeleteId(profile.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <ServerFormDialog
        open={formOpen}
        profile={editing}
        runtimes={runtimes}
        onOpenChange={(next) => {
          setFormOpen(next);
          if (!next) setEditing(null);
        }}
        onSaved={() => void handleSaved()}
      />

      <ConfigImportDialog
        open={importOpen}
        runtimes={runtimes}
        onOpenChange={setImportOpen}
        onImported={() => void reload()}
        onOpenRuntime={onOpenRuntime}
      />

      <ServerDetailDrawer
        open={detailProfile !== null}
        profile={detailProfile}
        snapshot={detailSnapshot}
        tunnels={tunnels}
        runtimes={runtimes}
        busy={detailProfile !== null && busyId === detailProfile.id}
        needsRestart={detailNeedsRestart}
        onOpenChange={(next) => {
          if (!next) setDetailId(null);
        }}
        onStart={() => runDetailAction(frpStart)}
        onStop={() => runDetailAction(frpStop)}
        onRestart={() => runDetailAction(frpRestart)}
        onEdit={() => {
          if (detailProfile) openEdit(detailProfile);
        }}
        onDelete={() => {
          if (detailProfile) setDeleteId(detailProfile.id);
        }}
        onViewLogs={() => {
          if (detailProfile) onOpenLogs(detailProfile.id);
        }}
      />

      <ServerDeleteDialog
        profile={deleteProfile}
        open={deleteProfile !== null}
        busy={deleteProfile !== null && busyId === deleteProfile.id}
        onOpenChange={(next) => {
          if (!next) setDeleteId(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
