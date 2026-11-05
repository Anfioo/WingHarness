import type { MouseEvent } from "react";
import { Loader2, Play, RotateCw, Square } from "lucide-react";
import type { ConnectionSnapshot, FrpProfile } from "@/commands/services/frp/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isActiveProcessState, StateBadge } from "@/components/frp/state-badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatEndpoint, formatLatency, formatVersion } from "@/lib/frp/format";

export type ConnectionCardProps = {
  profile: FrpProfile;
  /** `null` until the engine reports this profile at least once. */
  snapshot: ConnectionSnapshot | null;
  /** Tunnels configured on this profile, used for the online ratio. */
  tunnelCount: number;
  busy: boolean;
  /** The running process was launched from an older generated config. */
  needsRestart: boolean;
  onOpen: () => void;
  onStart: () => void;
  onStop: () => void;
  onRetry: () => void;
  onRestart: () => void;
};

/** One profile's live connection, as shown on the overview. */
export function ConnectionCard({
  profile,
  snapshot,
  tunnelCount,
  busy,
  needsRestart,
  onOpen,
  onStart,
  onStop,
  onRetry,
  onRestart,
}: ConnectionCardProps) {
  const { t } = useAppTranslation();

  const state = snapshot?.state ?? "stopped";
  const active = isActiveProcessState(state);
  const failed = state === "failed";
  const onlineTunnels = snapshot?.tunnelStates.filter((tunnel) => tunnel.state === "online").length;
  const lastError = snapshot?.lastError?.trim();

  const stopPropagation = (event: MouseEvent) => event.stopPropagation();

  return (
    <div
      className="border-border bg-card hover:border-ring/40 hover:bg-accent/30 flex flex-col gap-2 rounded-lg border p-3 transition-colors"
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="text-foreground min-w-0 truncate text-sm font-medium hover:underline"
          onClick={(event) => {
            stopPropagation(event);
            onOpen();
          }}
        >
          {profile.name}
        </button>
        <StateBadge state={state} />
        {needsRestart && (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-amber-700 dark:text-amber-400"
          >
            {t("frp.servers.badgeRestart")}
          </Badge>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1" onClick={stopPropagation}>
          {active ? (
            <>
              {needsRestart && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={onRestart}
                  title={t("frp.common.restart")}
                >
                  <RotateCw />
                  {t("frp.common.restart")}
                </Button>
              )}
              <Button variant="outline" size="xs" disabled={busy} onClick={onStop}>
                {busy ? <Loader2 className="animate-spin" /> : <Square />}
                {t("frp.common.stop")}
              </Button>
            </>
          ) : failed ? (
            <Button size="xs" disabled={busy} onClick={onRetry}>
              {busy ? <Loader2 className="animate-spin" /> : <RotateCw />}
              {t("frp.overview.retry")}
            </Button>
          ) : (
            <Button size="xs" disabled={busy} onClick={onStart}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              {t("frp.common.start")}
            </Button>
          )}
        </span>
      </div>

      <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="truncate font-mono">
          {formatEndpoint(profile.serverAddr, profile.serverPort)}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span>
          {t("frp.overview.pid")}: <span className="tabular-nums">{snapshot?.pid ?? "—"}</span>
        </span>
        <span>
          {t("frp.servers.col.latency")}:{" "}
          <span className="tabular-nums">{formatLatency(snapshot?.latencyMs)}</span>
        </span>
        <span>
          {t("frp.servers.col.tunnels")}:{" "}
          <span className="tabular-nums">
            {onlineTunnels ?? 0}/{tunnelCount}
          </span>
        </span>
        <span>
          {t("frp.servers.col.runtime")}: {formatVersion(snapshot?.runtimeVersion ?? null)}
        </span>
      </div>

      {lastError && (
        <p className="text-destructive line-clamp-2 text-xs break-words">{lastError}</p>
      )}
    </div>
  );
}
