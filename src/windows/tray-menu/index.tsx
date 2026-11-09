import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FolderOpen,
  Loader2,
  LogOut,
  Power,
  RadioTower,
  Settings,
  ShieldCheck,
  SquareArrowOutUpRight,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  agentStatus,
  clashApply,
  clashConnections,
  clashCoreStart,
  clashCoreStatus,
  clashCoreStop,
  clashProfileList,
  clashProfileSelect,
  clashProxies,
  clashProxySelect,
  clashRuntime,
  clashSetMode,
  clashSysProxy,
  clashSysProxySet,
  frpConnectionsList,
  frpProfilesList,
  inspectFile,
  openPreview,
  quitApp,
  setAgentEnabled,
  setTrayMenuExpanded,
  type AgentStatus,
  type ClashConnectionsView,
  type ClashCoreStatus,
  type ClashProfile,
  type ClashProxiesView,
  type ClashProxyGroup,
  type ClashProxyNode,
  type ClashRuntime,
  type ClashSysProxyStatus,
  type TrayMenuLayout,
} from "@/commands";
import { isActiveProcessState } from "@/components/frp/state-badge";
import { ThemeProvider } from "@/components/theme-provider";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { groupsForMode, isSelectable, toneClass } from "@/pages/clash/nodes";
import { formatBytes } from "@/pages/clash/shared";
import type { TrafficPoint } from "@/pages/clash/traffic-chart";
import { cn } from "@/lib/utils";
import { createWindow, showWindow } from "@/lib/window";
import { FrpPanel } from "./frp-panel";

/** How long the pointer must rest on the Clash row before the flyout opens. */
const OPEN_DELAY_MS = 140;
/** Grace period for crossing the seam between the menu and the flyout. */
const CLOSE_DELAY_MS = 220;
/** How long a click-closed flyout ignores hover while the window resizes. */
const HOVER_MUTE_MS = 500;
/** The flyout polls only while it is on screen. */
const POLL_MS = 3000;
/** The core's counters are cumulative; speeds are differences between samples. */
const TRAFFIC_POLL_MS = 1000;
/** A minute of one-second samples, the sparkline's whole window. */
const TRAFFIC_SAMPLES = 60;

type Side = TrayMenuLayout["side"];
type Vertical = TrayMenuLayout["vertical"];
/** Which row's flyout the popup is showing. */
type Panel = "clash" | "frp";

/**
 * The tray's right-click menu, shown in its own frameless, transparent window.
 *
 * Rust owns the window: it sizes it to the row geometry in
 * `src-tauri/src/plugins/tray_popup.rs`, positions it against the tray icon, and
 * hides it on blur. All this page does is draw the rows, run their actions, and
 * grow the window into the Clash flyout when the pointer rests on the Clash row.
 */
export default function TrayMenuPage() {
  const { t } = useAppTranslation();
  const appWindow = getCurrentWebviewWindow();

  // ── Clash state ──────────────────────────────────────────────────────────

  const [core, setCore] = useState<ClashCoreStatus | null>(null);
  const [runtime, setRuntime] = useState<ClashRuntime | null>(null);
  const [sysProxy, setSysProxy] = useState<ClashSysProxyStatus | null>(null);
  const [profiles, setProfiles] = useState<ClashProfile[]>([]);
  const [proxies, setProxies] = useState<ClashProxiesView | null>(null);
  const [connections, setConnections] = useState<ClashConnectionsView | null>(null);
  const [samples, setSamples] = useState<TrafficPoint[]>([]);
  const [speeds, setSpeeds] = useState({ up: 0, down: 0 });
  const [path, setPath] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The space agent; null when it cannot report yet, which disables the row. */
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  /** Only the newest load may write state; a slow poll must not undo a switch. */
  const requestId = useRef(0);
  /** The previous counters every rate is measured against. */
  const baseline = useRef<{ at: number; up: number; down: number } | null>(null);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const apply = <T,>(pending: Promise<T>, write: (next: T) => void) =>
      pending.then((next) => {
        if (id === requestId.current) write(next);
      });

    // Written as each answer lands: a controller call that is slow (or dead
    // while the core stops) must not hold back the core's own status.
    await Promise.all([
      apply(
        clashCoreStatus().catch(() => null),
        setCore
      ),
      apply(
        clashRuntime().catch(() => null),
        setRuntime
      ),
      apply(
        clashSysProxy().catch(() => null),
        setSysProxy
      ),
      apply(
        clashProfileList().catch(() => [] as ClashProfile[]),
        setProfiles
      ),
      apply(
        clashProxies().catch(() => null),
        setProxies
      ),
    ]);
  }, []);

  // ── FRP summary ──────────────────────────────────────────────────────────

  /** What the FRP row shows while its flyout is closed. */
  const [frpSummary, setFrpSummary] = useState<{ running: number; total: number } | null>(null);

  const loadFrp = useCallback(async () => {
    try {
      const [view, connections] = await Promise.all([frpProfilesList(), frpConnectionsList()]);
      setFrpSummary({
        running: view.profiles.filter((profile) =>
          isActiveProcessState(
            connections.find((entry) => entry.profileId === profile.id)?.state ?? "stopped"
          )
        ).length,
        total: view.profiles.length,
      });
    } catch {
      // The flyout reports its own failures; the row keeps its last count.
    }
  }, []);

  // ── Space agent ──────────────────────────────────────────────────────────

  const loadAgent = useCallback(async () => {
    try {
      setAgent(await agentStatus());
    } catch {
      // The agent could not report its state; leave the row disabled.
      setAgent(null);
    }
  }, []);

  // ── Flyout geometry ──────────────────────────────────────────────────────

  const [panel, setPanel] = useState<Panel | null>(null);
  const expanded = panel !== null;
  /**
   * A pinned flyout survives the pointer leaving the window; a hovered one
   * collapses as soon as it does. Clicking a row pins its flyout, clicking it
   * again (or clicking anywhere outside the popup) lets go.
   */
  const [pinned, setPinned] = useState(false);
  /**
   * Closing by click happens with the pointer still resting on the row.
   * Shrinking the window moves the card out from under it for a frame, which
   * Chromium reports as leave-then-enter — without this the flyout reopens on
   * its own a moment after it was closed. Set to a deadline rather than a flag
   * so a genuine hover later on still works.
   */
  const hoverMutedUntil = useRef(0);
  /** Which row the pointer is on right now, if any. */
  const overRow = useRef<Panel | null>(null);
  const [side, setSide] = useState<Side>("left");
  const [vertical, setVertical] = useState<Vertical>("up");
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const open = useCallback(
    async (which: Panel, pin: boolean) => {
      cancelOpen();
      cancelClose();
      try {
        const layout = await setTrayMenuExpanded(true);
        setSide(layout.side);
        setVertical(layout.vertical);
        setPanel(which);
        setPinned(pin);
      } catch (cause) {
        setError(String(cause));
      }
    },
    [cancelClose, cancelOpen]
  );

  const close = useCallback(async () => {
    cancelOpen();
    cancelClose();
    // Collapsing under the pointer moves the card out from under it for a
    // frame, which Chromium reports as leave-then-enter on the row. Mute hover
    // there so the flyout does not reopen by itself.
    if (overRow.current !== null) hoverMutedUntil.current = Date.now() + HOVER_MUTE_MS;
    setPanel(null);
    setPinned(false);
    setPath([]);
    setError(null);
    try {
      await setTrayMenuExpanded(false);
    } catch {
      // The window may already be hidden; the next open resets its size anyway.
    }
  }, [cancelClose, cancelOpen]);

  const scheduleOpen = useCallback(
    (which: Panel) => {
      if (panel === which || openTimer.current !== null) return;
      if (Date.now() < hoverMutedUntil.current) return;
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        void open(which, false);
      }, OPEN_DELAY_MS);
    },
    [open, panel]
  );

  const scheduleClose = useCallback(() => {
    if (panel === null || pinned || closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      void close();
    }, CLOSE_DELAY_MS);
  }, [close, panel, pinned]);

  // The window stays alive while hidden, so its state is stale on the next
  // open; Rust announces every open and this resets it before it is visible.
  useEffect(() => {
    void load();
    void loadFrp();
    void loadAgent();
    const unlisten = listen("tray-menu:opened", () => {
      cancelOpen();
      cancelClose();
      setPanel(null);
      setPinned(false);
      setPath([]);
      setBusy(null);
      setError(null);
      void load();
      void loadFrp();
      void loadAgent();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [cancelClose, cancelOpen, load, loadAgent, loadFrp]);

  useEffect(() => {
    if (panel !== "clash") return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [panel, load]);

  useEffect(() => {
    if (panel === "frp") void loadFrp();
  }, [loadFrp, panel]);

  const running = Boolean(core?.running);
  /** The core is mid start/stop: the header reports that instead of a state. */
  const coreBusy = busy === "core";
  const statusText = coreBusy
    ? running
      ? t("tray.clashPanel.stopping")
      : t("tray.clashPanel.starting")
    : running
      ? t("tray.clashPanel.on")
      : t("tray.clashPanel.off");

  // The counters are cumulative, so a speed is the difference between two
  // samples. Sampling stops with the flyout — nothing draws it while closed.
  useEffect(() => {
    baseline.current = null;
    setConnections(null);
    setSamples([]);
    setSpeeds({ up: 0, down: 0 });
    if (panel !== "clash" || !running) return;

    let cancelled = false;
    let sampling = false;

    const tick = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const next = await clashConnections();
        if (cancelled) return;
        setConnections(next);

        const now = Date.now();
        const previous = baseline.current;
        baseline.current = { at: now, up: next.uploadTotal, down: next.downloadTotal };
        if (!previous) return;

        const seconds = (now - previous.at) / 1000;
        if (seconds <= 0) return;
        const up = Math.max(0, next.uploadTotal - previous.up) / seconds;
        const down = Math.max(0, next.downloadTotal - previous.down) / seconds;
        setSpeeds({ up, down });
        setSamples((current) => [...current.slice(-(TRAFFIC_SAMPLES - 1)), { at: now, up, down }]);
      } catch {
        // A stopped core resets its counters; keeping the old baseline would
        // report a burst the moment it comes back.
        if (!cancelled) baseline.current = null;
      } finally {
        sampling = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), TRAFFIC_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [panel, running]);

  const groupNames = useMemo(
    () => new Set(proxies?.groups.map((group) => group.name) ?? []),
    [proxies]
  );
  const currentGroup = useMemo(() => {
    if (path.length === 0) return null;
    return proxies?.groups.find((group) => group.name === path[path.length - 1]) ?? null;
  }, [path, proxies]);

  // A profile switch can drop the group the flyout is looking at.
  useEffect(() => {
    if (path.length > 0 && proxies && !currentGroup) setPath([]);
  }, [currentGroup, path.length, proxies]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      if (busy !== null) return;
      setBusy(key);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(null);
        await load();
      }
    },
    [busy, load]
  );

  const toggleCore = useCallback(() => {
    void runAction("core", () => (running ? clashCoreStop() : clashCoreStart()));
  }, [runAction, running]);

  const toggleSysProxy = useCallback(() => {
    if (!sysProxy) return;
    void runAction("sysproxy", () => clashSysProxySet(!sysProxy.enabled));
  }, [runAction, sysProxy]);

  const changeMode = useCallback(
    (mode: string) => {
      void runAction("mode", () => clashSetMode(mode));
    },
    [runAction]
  );

  const selectProfile = useCallback(
    (profile: ClashProfile) => {
      if (profile.active) return;
      void runAction(`profile:${profile.id}`, async () => {
        await clashProfileSelect(profile.id);
        // Selecting only records the choice; the next start would still use the
        // old compiled output, so compile and hot-reload right away.
        await clashApply(false);
        setPath([]);
      });
    },
    [runAction]
  );

  const selectProxy = useCallback(
    async (group: ClashProxyGroup, member: ClashProxyNode) => {
      if (busy !== null || !isSelectable(group) || group.now === member.name) return;
      setBusy(`proxy:${group.name}`);
      setError(null);
      try {
        await clashProxySelect(group.name, member.name);
        // The core switched immediately; show it before the next poll lands.
        setProxies(
          (prev) =>
            prev && {
              ...prev,
              groups: prev.groups.map((item) =>
                item.name === group.name ? { ...item, now: member.name } : item
              ),
            }
        );
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(null);
      }
    },
    [busy]
  );

  // ── Menu actions ─────────────────────────────────────────────────────────

  // Hide first, then act: the other way round leaves the popup painted over
  // whatever the action just opened.
  const run = (action: () => void | Promise<void>) => {
    void appWindow.hide().then(action);
  };

  const openSettings = () =>
    createWindow("settings", {
      title: t("settings.title"),
      url: "/settings",
      width: 720,
      height: 600,
      minWidth: 560,
      minHeight: 480,
      resizable: true,
      maximizable: true,
      minimizable: false,
      decorations: false,
      transparent: true,
      shadow: false,
      center: true,
    });

  // The toggle stays open on click: the row itself is the feedback.
  const togglePreview = useCallback(() => {
    if (!agent || busy !== null) return;
    void runAction("preview", async () => {
      setAgent(await setAgentEnabled(!agent.enabled));
    });
  }, [agent, busy, runAction]);

  // Hide the popup first, then ask for a file: the native dialog would
  // otherwise paint over the menu.
  const openFile = useCallback(() => {
    void runAction("open-file", async () => {
      const picked = await openFileDialog({ multiple: false, title: t("tray.openFile") });
      if (typeof picked !== "string") return;
      await inspectFile(picked);
      await openPreview([picked]);
    });
  }, [runAction, t]);

  /**
   * Hover and click behaviour shared by the rows that own a flyout. Moving
   * between them swaps the panel in place; clicking pins, and clicking the
   * pinned row again closes it.
   */
  const flyoutRow = (which: Panel) => ({
    onMouseEnter: () => {
      overRow.current = which;
      // Coming back from the card keeps it open.
      cancelClose();
      scheduleOpen(which);
    },
    onMouseLeave: () => {
      overRow.current = null;
      cancelOpen();
      // Leaving the row for the flyout is fine — entering the card cancels
      // this again. Leaving it for the rest of the menu is leaving, so the
      // flyout goes.
      scheduleClose();
    },
    onSelect: () => {
      if (panel !== which) void open(which, true);
      else if (!pinned) setPinned(true);
      else void close();
    },
  });

  // Rust never sees this keystroke — the window has no native menu to absorb
  // it — so Escape is handled here. It backs out of the flyout before it closes
  // the whole menu.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (expanded) void close();
      else void appWindow.hide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [appWindow, close, expanded]);

  // ── Flyout ───────────────────────────────────────────────────────────────

  const proxyList = (() => {
    const hint = (text: string) => (
      <p className="text-muted-foreground flex h-full items-center justify-center px-3 text-center text-xs leading-relaxed">
        {text}
      </p>
    );

    if (!running) return hint(t("clash.proxy.offline"));
    if (runtime?.mode === "direct") return hint(t("clash.proxy.directMode"));
    if (!proxies) {
      return hint(runtime ? t("tray.clashPanel.proxiesFailed") : t("tray.clashPanel.loading"));
    }

    if (currentGroup) {
      const selectable = isSelectable(currentGroup);
      return currentGroup.members.map((member) => (
        <MemberRow
          key={member.name}
          member={member}
          active={member.name === currentGroup.now}
          selectable={selectable}
          busy={busy === `proxy:${currentGroup.name}`}
          nested={groupNames.has(member.name)}
          onSelect={() => void selectProxy(currentGroup, member)}
          onDrill={() => setPath((prev) => [...prev, member.name])}
        />
      ));
    }

    const groups = groupsForMode(proxies, runtime?.mode ?? "rule");
    if (groups.length === 0) return hint(t("clash.proxy.empty"));
    return groups.map((group) => (
      <GroupRow key={group.name} group={group} onOpen={() => setPath([group.name])} />
    ));
  })();

  const clashPanel = (
    <section
      // The card, not the window, owns the hover: the window also holds the
      // menu column, and moving back onto it has to count as leaving.
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      className="bg-popover text-popover-foreground border-border flex h-[460px] w-[340px] shrink-0 flex-col overflow-hidden rounded-md border select-none"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Zap className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{t("tray.clash")}</span>
        {coreBusy ? (
          <Loader2 className="text-muted-foreground ml-auto size-3 animate-spin" />
        ) : (
          <span
            className={cn(
              "ml-auto size-1.5 rounded-full",
              running ? "bg-emerald-500" : "bg-muted-foreground/40"
            )}
          />
        )}
        <span className="text-muted-foreground text-[11px]">{statusText}</span>
      </header>

      <div className="flex shrink-0 flex-col gap-0.5 border-b p-1.5">
        <ToggleRow
          icon={Power}
          label={t("tray.clashPanel.core")}
          checked={running}
          disabled={busy !== null}
          trailing={
            core && !core.binary.found ? (
              <span className="text-destructive truncate text-[10px]">
                {t("clash.core.missing")}
              </span>
            ) : busy === "core" ? (
              <Loader2 className="text-muted-foreground size-3 animate-spin" />
            ) : null
          }
          onToggle={toggleCore}
        />
        <ToggleRow
          icon={ShieldCheck}
          label={t("clash.runtime.sysProxy")}
          checked={Boolean(sysProxy?.enabled)}
          disabled={busy !== null || !sysProxy?.supported || (!running && !sysProxy?.enabled)}
          trailing={
            sysProxy?.enabled && sysProxy.server ? (
              <span className="text-muted-foreground/70 truncate font-mono text-[10px]">
                {sysProxy.server}
              </span>
            ) : !sysProxy?.supported ? (
              <span className="text-muted-foreground/70 truncate text-[10px]">
                {t("clash.runtime.unsupported")}
              </span>
            ) : null
          }
          onToggle={toggleSysProxy}
        />

        <div className="flex h-8 items-center gap-2 px-2">
          <span className="shrink-0 text-sm">{t("clash.runtime.mode")}</span>
          {runtime ? (
            <ModeSwitch value={runtime.mode} disabled={busy !== null} onChange={changeMode} />
          ) : (
            <span className="text-muted-foreground/70 truncate text-[11px]">
              {t("clash.runtime.modeOffline")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 px-2 py-1">
          <span className="shrink-0 text-sm">{t("tray.clashPanel.profiles")}</span>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {profiles.length === 0 ? (
              <span className="text-muted-foreground/70 truncate text-[11px]">
                {t("tray.clashPanel.noProfiles")}
              </span>
            ) : (
              profiles.map((profile) => (
                <ProfileChip
                  key={profile.id}
                  profile={profile}
                  busy={busy === `profile:${profile.id}`}
                  disabled={busy !== null}
                  onSelect={() => selectProfile(profile)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {running && (
        <div className="shrink-0 border-b px-2 py-1.5">
          <div className="flex items-baseline gap-2 font-mono text-[11px] tabular-nums">
            <span className="text-emerald-500">↑ {formatBytes(speeds.up)}/s</span>
            <span className="text-sky-500">↓ {formatBytes(speeds.down)}/s</span>
            <span className="text-muted-foreground/60 ml-auto truncate">
              {t("clash.home.downloaded")} {formatBytes(connections?.downloadTotal ?? 0)}
            </span>
          </div>
          <TrafficSparkline points={samples} />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
          {currentGroup && (
            <button
              type="button"
              title={t("tray.clashPanel.back")}
              className="hover:bg-accent rounded-sm p-0.5"
              onClick={() => setPath((prev) => prev.slice(0, -1))}
            >
              <ArrowLeft className="size-3.5" />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {currentGroup?.name ?? t("tray.clashPanel.proxies")}
          </span>
          {currentGroup && (
            <span className="text-muted-foreground max-w-[50%] truncate text-[11px]">
              {currentGroup.now
                ? t("clash.proxy.groupNow", { name: currentGroup.now })
                : t("clash.proxy.automatic")}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">{proxyList}</div>
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

  const frpPanel = (
    <FrpPanel onMouseEnter={cancelClose} onMouseLeave={scheduleClose} onChanged={loadFrp} />
  );

  const activePanel = panel === "clash" ? clashPanel : panel === "frp" ? frpPanel : null;

  return (
    <ThemeProvider defaultTheme="system" storageKey="tauri-ui-theme">
      <div
        // The window is transparent and the app has no native context menu for
        // this page, so the card *is* the menu — a right-click here must not
        // paint WebView2's own.
        onContextMenu={(event) => event.preventDefault()}
        className="h-full w-full"
      >
        <div
          className={cn("flex h-full w-full", vertical === "up" ? "items-end" : "items-start")}
          // The window is a rectangle but the cards are not: the empty corner
          // above or below the menu is still part of the window and would
          // swallow clicks, so a click on it closes the menu instead.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) void appWindow.hide();
          }}
        >
          {panel !== null && side === "left" && activePanel}

          <div className="bg-popover text-popover-foreground border-border flex h-[241px] w-[220px] shrink-0 flex-col rounded-md border p-1 select-none">
            <MenuItem
              icon={SquareArrowOutUpRight}
              label={t("tray.show")}
              onSelect={() => run(() => showWindow("main"))}
            />
            <MenuItem
              icon={Settings}
              label={t("tray.settings")}
              onSelect={() => run(openSettings)}
            />

            <ToggleRow
              icon={Eye}
              label={t("tray.preview")}
              checked={Boolean(agent?.enabled)}
              disabled={busy !== null || agent === null}
              trailing={
                agent ? (
                  <span className="text-muted-foreground/70 truncate text-[10px]">
                    {agent.enabled ? t("tray.previewOn") : t("tray.previewOff")}
                  </span>
                ) : null
              }
              onToggle={togglePreview}
            />

            <MenuItem icon={FolderOpen} label={t("tray.openFile")} onSelect={() => run(openFile)} />

            <MenuItem
              icon={Zap}
              label={t("tray.clash")}
              meta={core ? statusText : undefined}
              trailing={
                <ChevronDown
                  className={cn(
                    "text-muted-foreground size-3.5 shrink-0 transition-transform",
                    panel === "clash" && (side === "left" ? "rotate-90" : "-rotate-90")
                  )}
                />
              }
              {...flyoutRow("clash")}
            />

            <MenuItem
              icon={RadioTower}
              label={t("tray.frp")}
              meta={
                frpSummary
                  ? t("tray.frpPanel.runningCount", {
                      running: frpSummary.running,
                      total: frpSummary.total,
                    })
                  : undefined
              }
              trailing={
                <ChevronDown
                  className={cn(
                    "text-muted-foreground size-3.5 shrink-0 transition-transform",
                    panel === "frp" && (side === "left" ? "rotate-90" : "-rotate-90")
                  )}
                />
              }
              {...flyoutRow("frp")}
            />

            {/* my-1 + h-px — the 9px the Rust-side height arithmetic accounts for. */}
            <div className="bg-border my-1 h-px" />

            <MenuItem icon={LogOut} label={t("tray.quit")} onSelect={() => run(() => quitApp())} />
          </div>

          {panel !== null && side === "right" && activePanel}
        </div>
      </div>
    </ThemeProvider>
  );
}

/**
 * One row. `h-8` is not cosmetic: the window is sized to these rows from
 * constants rather than measured, so the height has to stay exactly 32px.
 */
function MenuItem({
  icon: Icon,
  label,
  meta,
  trailing,
  onSelect,
  onMouseEnter,
  onMouseLeave,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  trailing?: ReactNode;
  onSelect: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="hover:bg-accent hover:text-accent-foreground flex h-8 shrink-0 items-center gap-2 rounded-sm px-2 text-sm"
    >
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate">{label}</span>
      {meta && (
        <span className="text-muted-foreground/70 ml-auto shrink-0 text-[11px]">{meta}</span>
      )}
      {trailing}
    </button>
  );
}

/** A switch-shaped row: the whole row is the hit target, so the pill is inert. */
function ToggleRow({
  icon: Icon,
  label,
  checked,
  disabled,
  trailing,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  checked: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className="hover:bg-accent hover:text-accent-foreground flex h-8 shrink-0 items-center gap-2 rounded-sm px-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="shrink-0">{label}</span>
      {trailing}
      <span
        className={cn(
          "ml-auto flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-xs transition-colors",
          checked ? "bg-primary" : "bg-input"
        )}
      >
        <span
          className={cn(
            "bg-background block size-4 rounded-full shadow-lg transition-transform",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </span>
    </button>
  );
}

function ModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (mode: string) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="bg-muted flex shrink-0 items-center gap-0.5 rounded-md p-0.5">
      {["rule", "global", "direct"].map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          onClick={() => onChange(mode)}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed",
            value === mode
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t(`clash.runtime.modes.${mode}`)}
        </button>
      ))}
    </div>
  );
}

function ProfileChip({
  profile,
  busy,
  disabled,
  onSelect,
}: {
  profile: ClashProfile;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || profile.active}
      onClick={onSelect}
      title={profile.name}
      className={cn(
        "flex h-5 max-w-[8rem] shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] transition-colors",
        profile.active
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "text-muted-foreground hover:text-foreground hover:border-primary/40",
        "disabled:cursor-default"
      )}
    >
      {busy ? (
        <Loader2 className="size-3 shrink-0 animate-spin" />
      ) : profile.active ? (
        <Check className="text-primary size-3 shrink-0" />
      ) : null}
      <span className="truncate">{profile.name}</span>
    </button>
  );
}

function GroupRow({ group, onOpen }: { group: ClashProxyGroup; onOpen: () => void }) {
  const { t } = useAppTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hover:bg-accent hover:text-accent-foreground flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
    >
      <span className="min-w-0 flex-1 truncate">{group.name}</span>
      <span className="text-muted-foreground max-w-[45%] truncate text-[11px]">
        {group.now || t("clash.proxy.automatic")}
      </span>
      <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
    </button>
  );
}

/**
 * A bare up/down speed trace. No axes or hover: at 36px tall the shape is the
 * whole story, and the exact numbers sit right above it.
 */
function TrafficSparkline({ points }: { points: TrafficPoint[] }) {
  const width = 320;
  const height = 36;
  const ceiling = points.reduce((max, point) => Math.max(max, point.up, point.down), 1);
  const x = (index: number) => (points.length <= 1 ? 0 : (index / (points.length - 1)) * width);
  const y = (value: number) => height - (value / ceiling) * height;
  const trace = (key: "up" | "down") =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${x(index).toFixed(1)} ${y(point[key]).toFixed(1)}`
      )
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-1 h-9 w-full"
      aria-hidden
    >
      {[
        { key: "down" as const, color: "#0ea5e9" },
        { key: "up" as const, color: "#10b981" },
      ].map((line) => (
        <path
          key={line.key}
          d={trace(line.key)}
          fill="none"
          stroke={line.color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function MemberRow({
  member,
  active,
  selectable,
  busy,
  nested,
  onSelect,
  onDrill,
}: {
  member: ClashProxyNode;
  active: boolean;
  selectable: boolean;
  busy: boolean;
  nested: boolean;
  onSelect: () => void;
  onDrill: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className={cn("flex h-8 w-full items-center rounded-sm", active && "bg-primary/10")}>
      <button
        type="button"
        disabled={!selectable || busy}
        onClick={onSelect}
        title={
          selectable ? t("clash.proxy.select", { name: member.name }) : t("clash.proxy.automatic")
        }
        className="hover:bg-accent hover:text-accent-foreground flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-left text-sm disabled:cursor-default disabled:hover:bg-transparent"
      >
        {active ? (
          <Check className="text-primary size-3.5 shrink-0" />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{member.name}</span>
        <span className={cn("shrink-0 font-mono text-[11px] tabular-nums", toneClass(member))}>
          {!member.alive
            ? t("clash.proxy.dead")
            : member.delay === null
              ? "—"
              : `${member.delay} ms`}
        </span>
      </button>
      {nested && (
        <button
          type="button"
          onClick={onDrill}
          title={member.name}
          className="hover:bg-accent mr-1 shrink-0 rounded-sm p-1"
        >
          <ChevronRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}
