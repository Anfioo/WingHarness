import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Package, Play, RotateCw, Server, Square } from "lucide-react";
import { toast } from "sonner";
import {
  frpProfileDelete,
  frpRestart,
  frpStart,
  frpStartAll,
  frpStop,
  frpStopAll,
} from "@/commands/services/frp";
import type { FrpProfile, RuntimeView } from "@/commands/services/frp/types";
import { ConnectionCard } from "@/components/frp/connection-card";
import { ServerDeleteDialog, ServerDetailDrawer } from "@/components/frp/server-detail-drawer";
import { ServerFormDialog } from "@/components/frp/server-form-dialog";
import { StatChips, type StatChip } from "@/components/frp/stat-chips";
import { isActiveProcessState } from "@/components/frp/state-badge";
import { Button } from "@/components/ui/button";
import type { FrpWorkspace } from "@/hooks/use-frp-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatVersion, frpErrorOutput, frpFailureKey } from "@/lib/frp/format";

export type OverviewTabProps = {
  workspace: FrpWorkspace;
  /** Switch to the runtime tab; used by the no-runtime guide. */
  onOpenRuntime: () => void;
  /** Switch to the logs tab with this profile preselected. */
  onOpenLogs: (profileId: string) => void;
};

function latestRuntime(runtimes: RuntimeView[]): RuntimeView | null {
  let best: RuntimeView | null = null;
  for (const runtime of runtimes) {
    if (
      !best ||
      runtime.version.localeCompare(best.version, undefined, {
        numeric: true,
        sensitivity: "base",
      }) > 0
    ) {
      best = runtime;
    }
  }
  return best;
}

/**
 * The overview: at-a-glance counters, batch actions and one card per
 * connection. While anything is running only the active connections are shown;
 * when everything is idle the full profile list stands in for them.
 */
export function OverviewTab({ workspace, onOpenRuntime, onOpenLogs }: OverviewTabProps) {
  const { t } = useAppTranslation();
  const { profiles, runtimes, snapshots, tunnels, reload, runAction } = workspace;

  const [batchBusy, setBatchBusy] = useState<"start" | "stop" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
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

  const activeProfiles = useMemo(
    () => profiles.filter((profile) => isActiveProcessState(snapshots[profile.id]?.state)),
    [profiles, snapshots]
  );

  const failedProfiles = useMemo(
    () => profiles.filter((profile) => snapshots[profile.id]?.state === "failed"),
    [profiles, snapshots]
  );

  const shownProfiles = activeProfiles.length > 0 ? activeProfiles : profiles;

  const onlineTunnels = useMemo(
    () =>
      activeProfiles.reduce(
        (total, profile) =>
          total +
          (snapshots[profile.id]?.tunnelStates.filter((entry) => entry.state === "online").length ??
            0),
        0
      ),
    [activeProfiles, snapshots]
  );

  const recommendedRuntime = useMemo(() => latestRuntime(runtimes), [runtimes]);

  const stats: StatChip[] = [
    {
      key: "connected",
      label: t("frp.overview.statConnected"),
      value: `${activeProfiles.length}/${profiles.length}`,
    },
    {
      key: "tunnels",
      label: t("frp.overview.statTunnels"),
      value: `${onlineTunnels}/${tunnels.length}`,
    },
    {
      key: "failed",
      label: t("frp.overview.statErrors"),
      value: String(failedProfiles.length),
      tone: failedProfiles.length > 0 ? "warning" : "default",
    },
    {
      key: "runtime",
      label: t("frp.overview.statRuntime"),
      value: formatVersion(recommendedRuntime?.version ?? null),
    },
  ];

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

  const runBatch = async (mode: "start" | "stop") => {
    setBatchBusy(mode);
    try {
      const result = await runAction(() => (mode === "start" ? frpStartAll() : frpStopAll()));
      for (const failure of result.failed) {
        const profile = profiles.find((entry) => entry.id === failure.profileId);
        const key = frpFailureKey(failure.error);
        const detail = frpErrorOutput(failure.error) ?? failure.error.message.trim();
        const message = key ? (detail ? `${t(key)}: ${detail}` : t(key)) : detail;
        toast.error(
          t("frp.overview.batchFailed", {
            name: profile?.name ?? failure.profileId,
            error: message || t("frp.error.internal"),
          })
        );
      }
      await reload();
    } catch {
      // The command itself failed; `runAction` shows that in the banner.
    } finally {
      setBatchBusy(null);
    }
  };

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

  const noRuntimes = runtimes.length === 0;
  const batchDisabled = profiles.length === 0 || batchBusy !== null;

  return (
    <div className="flex flex-col gap-3">
      {noRuntimes && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <Package className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("frp.overview.noRuntime.title")}</p>
            <p className="text-muted-foreground text-xs">
              {t("frp.overview.noRuntime.description")}
            </p>
          </div>
          <Button size="sm" onClick={onOpenRuntime}>
            {t("frp.overview.noRuntime.action")}
          </Button>
        </div>
      )}

      <StatChips items={stats} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={batchDisabled || noRuntimes}
          onClick={() => void runBatch("start")}
        >
          {batchBusy === "start" ? <Loader2 className="animate-spin" /> : <Play />}
          {t("frp.overview.startAll")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={batchDisabled}
          onClick={() => void runBatch("stop")}
        >
          {batchBusy === "stop" ? <Loader2 className="animate-spin" /> : <Square />}
          {t("frp.overview.stopAll")}
        </Button>
      </div>

      {failedProfiles.length > 0 && (
        <section className="border-destructive/30 bg-destructive/5 flex flex-col gap-2 rounded-lg border p-3">
          <h2 className="text-destructive flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="size-4" />
            {t("frp.overview.failedHeading")}
          </h2>
          <ul className="flex flex-col gap-1" role="list">
            {failedProfiles.map((profile) => (
              <li key={profile.id} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium">{profile.name}</span>
                <span className="text-destructive/80 line-clamp-1 min-w-0 flex-1 break-words">
                  {snapshots[profile.id]?.lastError?.trim() || "—"}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busyId === profile.id}
                  onClick={() => void runProfileAction(profile.id, () => frpRestart(profile.id))}
                >
                  {busyId === profile.id ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  {t("frp.overview.retry")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {profiles.length === 0 ? (
        <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <Server className="size-8" />
          <p className="text-foreground font-medium">{t("frp.overview.empty.title")}</p>
          <p className="max-w-md">{t("frp.overview.empty.description")}</p>
          {!noRuntimes && (
            <Button size="sm" onClick={openCreate}>
              {t("frp.servers.empty.action")}
            </Button>
          )}
        </div>
      ) : (
        <section className="flex flex-col gap-2">
          <h2 className="text-foreground text-sm font-medium">
            {activeProfiles.length > 0
              ? t("frp.overview.activeConnections")
              : t("frp.overview.allServers")}
          </h2>
          <div className="grid gap-2 lg:grid-cols-2">
            {shownProfiles.map((profile) => {
              const snapshot = snapshots[profile.id] ?? null;
              return (
                <ConnectionCard
                  key={profile.id}
                  profile={profile}
                  snapshot={snapshot}
                  tunnelCount={tunnelCounts[profile.id] ?? 0}
                  busy={busyId === profile.id}
                  needsRestart={
                    snapshot !== null && snapshot.configRevision !== profile.configRevision
                  }
                  onOpen={() => setDetailId(profile.id)}
                  onStart={() => void runProfileAction(profile.id, () => frpStart(profile.id))}
                  onStop={() => void runProfileAction(profile.id, () => frpStop(profile.id))}
                  onRetry={() => void runProfileAction(profile.id, () => frpRestart(profile.id))}
                  onRestart={() => void runProfileAction(profile.id, () => frpRestart(profile.id))}
                />
              );
            })}
          </div>
        </section>
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
