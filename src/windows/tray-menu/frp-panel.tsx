// The tray's FRP flyout.
//
// One row per profile: the switch starts or stops it, the arrow button restarts
// it, and clicking the row opens that profile's tunnels, where each tunnel has
// its own switch. Mounted only while the flyout is open, so its poll stops with
// the flyout.

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  Play,
  RadioTower,
  RefreshCw,
  Square,
  type LucideIcon,
} from "lucide-react";
import {
  frpConnectionsList,
  frpProfilesList,
  frpRestart,
  frpStart,
  frpStartAll,
  frpStop,
  frpStopAll,
  frpTunnelUpdate,
  frpTunnelsList,
  isFrpError,
  type ConnectionSnapshot,
  type FrpProfile,
  type ProcessState,
  type Tunnel,
} from "@/commands";
import { isActiveProcessState } from "@/components/frp/state-badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatEndpoint, frpErrorOutput, frpFailureKey } from "@/lib/frp/format";
import { cn } from "@/lib/utils";

/** While open, the process states are re-read at this interval. */
const POLL_MS = 3000;

export type FrpPanelProps = {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Lets the menu row's status text follow what the panel just did. */
  onChanged: () => void;
};

export function FrpPanel({ onMouseEnter, onMouseLeave, onChanged }: FrpPanelProps) {
  const { t } = useAppTranslation();
  const [profiles, setProfiles] = useState<FrpProfile[]>([]);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [connections, setConnections] = useState<ConnectionSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Id of the profile whose tunnels are shown, or null for the profile list. */
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [view, tunnelList, connectionList] = await Promise.all([
        frpProfilesList(),
        frpTunnelsList(),
        frpConnectionsList(),
      ]);
      setProfiles(view.profiles);
      setTunnels(tunnelList);
      setConnections(connectionList);
      setLoaded(true);
    } catch {
      // Keep the last known lists: a failed poll is not worth replacing the
      // actions with an error the user cannot do anything about.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const stateOf = useCallback(
    (profileId: string): ProcessState =>
      connections.find((entry) => entry.profileId === profileId)?.state ?? "stopped",
    [connections]
  );

  const describe = useCallback(
    (failure: unknown) => {
      const key = frpFailureKey(failure);
      // A rejected config explains itself through frpc's own output.
      const output = frpErrorOutput(failure);
      const message = isFrpError(failure) ? failure.message.trim() : String(failure);
      const detail = output ?? message;
      return key ? (detail ? `${t(key)}: ${detail}` : t(key)) : detail;
    },
    [t]
  );

  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      if (busy !== null) return;
      setBusy(key);
      setError(null);
      try {
        await action();
      } catch (failure) {
        setError(describe(failure));
      } finally {
        setBusy(null);
        await load();
        onChanged();
      }
    },
    [busy, describe, load, onChanged]
  );

  const toggleProfile = useCallback(
    (profile: FrpProfile) => {
      const active = isActiveProcessState(stateOf(profile.id));
      void runAction(`profile:${profile.id}`, () =>
        active ? frpStop(profile.id) : frpStart(profile.id)
      );
    },
    [runAction, stateOf]
  );

  const restartProfile = useCallback(
    (profile: FrpProfile) => {
      void runAction(`restart:${profile.id}`, () => frpRestart(profile.id));
    },
    [runAction]
  );

  const toggleTunnel = useCallback(
    (tunnel: Tunnel) => {
      void runAction(`tunnel:${tunnel.id}`, async () => {
        const updated = await frpTunnelUpdate(tunnel.id, {
          profileId: tunnel.profileId,
          name: tunnel.name,
          type: tunnel.type,
          enabled: !tunnel.enabled,
          localIp: tunnel.localIp,
          localPort: tunnel.localPort,
          options: tunnel.options,
        });
        setTunnels((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry))
        );
        // The config is rebuilt only on start, so a running profile keeps the
        // old tunnel set until it is restarted.
        if (isActiveProcessState(stateOf(tunnel.profileId))) {
          await frpRestart(tunnel.profileId);
        }
      });
    },
    [runAction, stateOf]
  );

  const runBatch = useCallback(
    (mode: "start" | "stop") => {
      void runAction(`batch:${mode}`, async () => {
        const result = mode === "start" ? await frpStartAll() : await frpStopAll();
        if (result.failed.length > 0) {
          const failure = result.failed[0];
          const name =
            profiles.find((profile) => profile.id === failure.profileId)?.name ?? failure.profileId;
          setError(`${name}: ${describe(failure.error)}`);
        }
      });
    },
    [describe, profiles, runAction]
  );

  const current = path === null ? null : (profiles.find((profile) => profile.id === path) ?? null);
  const currentTunnels = current ? tunnels.filter((tunnel) => tunnel.profileId === current.id) : [];
  const runningCount = profiles.filter((profile) =>
    isActiveProcessState(stateOf(profile.id))
  ).length;

  // The profile can be deleted from another window while its tunnels are open.
  useEffect(() => {
    if (path !== null && loaded && !current) setPath(null);
  }, [current, loaded, path]);

  const list = (() => {
    const hint = (text: string) => (
      <p className="text-muted-foreground flex h-full items-center justify-center px-3 text-center text-xs leading-relaxed">
        {text}
      </p>
    );

    if (!loaded) return hint(t("tray.frpPanel.loading"));
    if (current) {
      if (currentTunnels.length === 0) return hint(t("tray.frpPanel.noTunnels"));
      return currentTunnels.map((tunnel) => (
        <TunnelRow
          key={tunnel.id}
          tunnel={tunnel}
          busy={busy === `tunnel:${tunnel.id}`}
          disabled={busy !== null}
          onToggle={() => toggleTunnel(tunnel)}
        />
      ));
    }
    if (profiles.length === 0) return hint(t("tray.frpPanel.noProfiles"));
    return profiles.map((profile) => (
      <ProfileRow
        key={profile.id}
        profile={profile}
        state={stateOf(profile.id)}
        busy={busy === `profile:${profile.id}`}
        restarting={busy === `restart:${profile.id}`}
        disabled={busy !== null}
        onOpen={() => setPath(profile.id)}
        onRestart={() => restartProfile(profile)}
        onToggle={() => toggleProfile(profile)}
      />
    ));
  })();

  return (
    <section
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="bg-popover text-popover-foreground border-border flex h-[460px] w-[340px] shrink-0 flex-col overflow-hidden rounded-md border select-none"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <RadioTower className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{t("tray.frp")}</span>
        {busy?.startsWith("batch:") ? (
          <Loader2 className="text-muted-foreground ml-auto size-3 animate-spin" />
        ) : (
          <span
            className={cn(
              "ml-auto size-1.5 rounded-full",
              runningCount > 0 ? "bg-emerald-500" : "bg-muted-foreground/40"
            )}
          />
        )}
        <span className="text-muted-foreground text-[11px]">
          {t("tray.frpPanel.runningCount", { running: runningCount, total: profiles.length })}
        </span>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b p-1.5">
        <BatchButton
          icon={Play}
          label={t("tray.frpPanel.startAll")}
          disabled={busy !== null || profiles.length === 0}
          busy={busy === "batch:start"}
          onClick={() => runBatch("start")}
        />
        <BatchButton
          icon={Square}
          label={t("tray.frpPanel.stopAll")}
          disabled={busy !== null || runningCount === 0}
          busy={busy === "batch:stop"}
          onClick={() => runBatch("stop")}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
          {current && (
            <button
              type="button"
              title={t("tray.frpPanel.back")}
              className="hover:bg-accent rounded-sm p-0.5"
              onClick={() => setPath(null)}
            >
              <ArrowLeft className="size-3.5" />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {current?.name ?? t("tray.frpPanel.profiles")}
          </span>
          {current && (
            <span
              className="text-muted-foreground shrink-0 text-[11px]"
              title={t("tray.frpPanel.tunnels")}
            >
              {t("tray.frpPanel.tunnelCount", { count: currentTunnels.length })}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">{list}</div>
      </div>

      {error && (
        <p
          className="text-destructive shrink-0 truncate border-t px-3 py-1.5 text-[11px]"
          title={error}
        >
          {error}
        </p>
      )}
    </section>
  );
}

/** The dot's colour, matching the state badges on the FRP page. */
function dotClass(state: ProcessState): string {
  switch (state) {
    case "running":
      return "bg-emerald-500";
    case "starting":
    case "reconnecting":
    case "stopping":
      return "bg-amber-500";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function ProfileRow({
  profile,
  state,
  busy,
  restarting,
  disabled,
  onOpen,
  onRestart,
  onToggle,
}: {
  profile: FrpProfile;
  state: ProcessState;
  busy: boolean;
  restarting: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRestart: () => void;
  onToggle: () => void;
}) {
  const { t } = useAppTranslation();
  const active = isActiveProcessState(state);
  const endpoint = formatEndpoint(profile.serverAddr, profile.serverPort);

  return (
    <div className="flex h-8 items-center gap-1 rounded-sm pr-1">
      <button
        type="button"
        onClick={onOpen}
        title={endpoint}
        className="hover:bg-accent hover:text-accent-foreground flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-left"
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", dotClass(state))} />
        <span className="min-w-0 flex-1 truncate text-sm">{profile.name}</span>
        <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
      </button>
      <button
        type="button"
        disabled={disabled}
        title={t("tray.frpPanel.restart")}
        onClick={onRestart}
        className="hover:bg-accent shrink-0 rounded-sm p-1 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {restarting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
      </button>
      {busy ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <SwitchButton
          checked={active}
          disabled={disabled}
          label={active ? t("tray.frpPanel.stop") : t("tray.frpPanel.start")}
          onToggle={onToggle}
        />
      )}
    </div>
  );
}

function TunnelRow({
  tunnel,
  busy,
  disabled,
  onToggle,
}: {
  tunnel: Tunnel;
  busy: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "hover:bg-accent flex h-8 items-center gap-2 rounded-sm px-2",
        !tunnel.enabled && "opacity-60"
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tunnel.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm">{tunnel.name}</span>
      <span className="text-muted-foreground shrink-0 font-mono text-[10px] uppercase">
        {tunnel.type}
      </span>
      {busy ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <SwitchButton
          checked={tunnel.enabled}
          disabled={disabled}
          label={tunnel.name}
          onToggle={onToggle}
        />
      )}
    </div>
  );
}

/** A compact switch; the row it sits in is not the hit target, unlike the page. */
function SwitchButton({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex h-4 w-7 shrink-0 items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "bg-background block size-3 rounded-full shadow-lg transition-transform",
          checked ? "translate-x-3" : "translate-x-0"
        )}
      />
    </button>
  );
}

function BatchButton({
  icon: Icon,
  label,
  disabled,
  busy,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="hover:bg-accent hover:text-accent-foreground flex h-7 flex-1 items-center justify-center gap-1.5 rounded-sm text-xs disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
