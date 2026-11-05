import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Plus, RefreshCw, X } from "lucide-react";
import {
  base64ToBytes,
  serverConnect,
  serverConnectionClose,
  serverDisconnect,
  serverResize,
  serverWrite,
} from "@/commands/services/servers";
import {
  isServerError,
  serverErrorCode,
  type ConnectOutcome,
  type ConnectionState,
  type ServerExitEvent,
  type ServerOutputEvent,
} from "@/commands/services/servers/types";
import type { HostKeyRequest } from "@/components/servers/host-key-dialog";
import {
  useTerminalTheme,
  XtermHost,
  type TerminalSize,
  type XtermHostHandle,
} from "@/components/terminal/xterm-host";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { errorText, serverErrorCodeKey } from "@/lib/servers/format";
import { cn } from "@/lib/utils";
import type { TerminalPrefs } from "@/pages/local-terminal/prefs";

/** Mirrors `server_core::events`; the names are frozen on the Rust side. */
const OUTPUT_EVENT = "server:output";
const EXIT_EVENT = "server:exit";

const ENCODER = new TextEncoder();
/**
 * DECAWM, the terminal's own wrap mode. It belongs to the local xterm: writing
 * it to the remote pty makes the shell echo the bytes back as literal text
 * (`^[[?7h`) before it switches to raw mode.
 */
const AUTO_WRAP_ON = "\x1b[?7h";
const AUTO_WRAP_OFF = "\x1b[?7l";

type ShellStatus = "idle" | "connecting" | "ready" | "exited" | "failed";

type ShellTab = {
  id: string;
  seq: number;
  sessionId: string | null;
  status: ShellStatus;
  /** Reason the remote side gave when the shell ended, if any. */
  reason: string | null;
  error: unknown;
};

function makeShellTab(seq: number): ShellTab {
  return {
    id: `shell-${Date.now()}-${seq}`,
    seq,
    sessionId: null,
    status: "idle",
    reason: null,
    error: null,
  };
}

function hostKeyRequest(
  failure: unknown,
  profileId: string,
  cols: number,
  rows: number
): HostKeyRequest {
  const detail = isServerError(failure) ? failure.detail : null;
  const read = (key: string): string => {
    const value = detail?.[key];
    return typeof value === "string" ? value : "";
  };
  const mode = serverErrorCode(failure) === "host-key-mismatch" ? "mismatch" : "unknown";
  return {
    profileId,
    // A mismatch reports the presented key as `presented`; first contact
    // reports it as `fingerprint`.
    fingerprint: mode === "mismatch" ? read("presented") : read("fingerprint"),
    algorithm: read("algorithm") || "unknown",
    cols,
    rows,
    mode,
    trusted: mode === "mismatch" ? read("trusted") : undefined,
  };
}

/** What the server tab drives from its own header. */
export type SshTabHandle = {
  /** Close every shell channel, then the profile's connection. */
  disconnectAll: () => Promise<void>;
  /** Re-open a shell in every tab that has no live session. */
  reconnectAll: () => void;
  /** Bind the connection a host-key retry produced to the tab that asked. */
  adoptConnection: (outcome: ConnectOutcome) => void;
};

export type SshTabProps = {
  profileId: string;
  /** Visible on screen: the terminal can only be measured and focused then. */
  active: boolean;
  prefs: TerminalPrefs;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: unknown) => void;
  onHostKeyRequired?: (request: HostKeyRequest) => void;
  expose?: (handle: SshTabHandle | null) => void;
};

/**
 * The shell tabs of one server. Every tab is an independent shell channel on
 * the profile's single SSH connection; the terminal panes stay mounted (hidden)
 * so switching tabs keeps the scrollback.
 *
 * Output and exit events are listened for once here and routed by session id,
 * so opening another shell does not add another pair of window listeners.
 */
export function SshTab({
  profileId,
  active,
  prefs,
  onStateChange,
  onError,
  onHostKeyRequired,
  expose,
}: SshTabProps) {
  const { t } = useAppTranslation();
  const theme = useTerminalTheme();

  const seqRef = useRef(1);
  const [tabs, setTabs] = useState<ShellTab[]>(() => [makeShellTab(1)]);
  // The first shell has no user gesture to switch to it.
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null);

  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const panesRef = useRef(new Map<string, XtermHostHandle>());
  /** Live channels only: an exited session stays in the tab state for display. */
  const sessionByTabRef = useRef(new Map<string, string>());
  /**
   * The reverse index, filled synchronously when a session is assigned. Output
   * events are routed through it rather than through React state, which only
   * commits after the first prompt may already have arrived.
   */
  const tabBySessionRef = useRef(new Map<string, string>());
  const inFlightRef = useRef(new Set<string>());
  /** Bumped by `disconnectAll` so connects that were already in flight give up. */
  const epochRef = useRef(0);
  const awaitingTabRef = useRef<string | null>(null);
  const disposedRef = useRef(false);

  const onStateChangeRef = useRef(onStateChange);
  const onErrorRef = useRef(onError);
  const onHostKeyRef = useRef(onHostKeyRequired);
  const exposeRef = useRef(expose);
  const autoWrapRef = useRef(prefs.autoWrap);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onHostKeyRef.current = onHostKeyRequired;
  }, [onHostKeyRequired]);
  useEffect(() => {
    exposeRef.current = expose;
  }, [expose]);
  useEffect(() => {
    autoWrapRef.current = prefs.autoWrap;
  }, [prefs.autoWrap]);

  /** Set the local terminal's wrap mode; never write this to the remote pty. */
  const applyAutoWrap = useCallback((tabId: string) => {
    panesRef.current.get(tabId)?.write(autoWrapRef.current ? AUTO_WRAP_ON : AUTO_WRAP_OFF);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      sessionByTabRef.current.forEach((sessionId) => {
        void serverDisconnect(sessionId).catch(() => {});
      });
      sessionByTabRef.current.clear();
      tabBySessionRef.current.clear();
    };
  }, []);

  const patchTab = useCallback((tabId: string, patch: Partial<ShellTab>) => {
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)));
  }, []);

  const connectTab = useCallback(
    async (tabId: string) => {
      const handle = panesRef.current.get(tabId);
      if (!handle || inFlightRef.current.has(tabId) || sessionByTabRef.current.has(tabId)) {
        return;
      }
      inFlightRef.current.add(tabId);
      const epoch = epochRef.current;
      patchTab(tabId, { status: "connecting", error: null, reason: null });

      try {
        const outcome = await serverConnect(profileId, handle.term.cols, handle.term.rows, false);
        if (
          disposedRef.current ||
          epoch !== epochRef.current ||
          !tabsRef.current.some((tab) => tab.id === tabId)
        ) {
          void serverDisconnect(outcome.sessionId).catch(() => {});
          return;
        }
        sessionByTabRef.current.set(tabId, outcome.sessionId);
        tabBySessionRef.current.set(outcome.sessionId, tabId);
        patchTab(tabId, {
          sessionId: outcome.sessionId,
          status: "ready",
          error: null,
          reason: null,
        });
        applyAutoWrap(tabId);
      } catch (failure) {
        if (disposedRef.current || epoch !== epochRef.current) return;
        patchTab(tabId, { status: "failed", error: failure });
        onErrorRef.current?.(failure);

        const code = serverErrorCode(failure);
        if (code === "host-key-unknown" || code === "host-key-mismatch") {
          awaitingTabRef.current = tabId;
          onHostKeyRef.current?.(
            hostKeyRequest(failure, profileId, handle.term.cols, handle.term.rows)
          );
        }
      } finally {
        inFlightRef.current.delete(tabId);
      }
    },
    [applyAutoWrap, patchTab, profileId]
  );

  // Output/exit events are window-wide; each server tab drops the ids it does
  // not own, which also discards events left over from closed tabs.
  useEffect(() => {
    let disposed = false;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    void listen<ServerOutputEvent>(OUTPUT_EVENT, (event) => {
      const tabId = tabBySessionRef.current.get(event.payload.sessionId);
      if (!tabId) return;
      panesRef.current.get(tabId)?.write(base64ToBytes(event.payload.data));
    }).then((fn) => {
      if (disposed) fn();
      else unlistenOutput = fn;
    });

    void listen<ServerExitEvent>(EXIT_EVENT, (event) => {
      const tabId = tabBySessionRef.current.get(event.payload.sessionId);
      if (!tabId) return;
      tabBySessionRef.current.delete(event.payload.sessionId);
      sessionByTabRef.current.delete(tabId);
      patchTab(tabId, { status: "exited", reason: event.payload.reason });
    }).then((fn) => {
      if (disposed) fn();
      else unlistenExit = fn;
    });

    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, [patchTab]);

  // Live-apply the auto-wrap preference to every open shell.
  useEffect(() => {
    panesRef.current.forEach((handle) => {
      handle.write(prefs.autoWrap ? AUTO_WRAP_ON : AUTO_WRAP_OFF);
    });
  }, [prefs.autoWrap]);

  const sendData = useCallback((tabId: string, data: string) => {
    const sessionId = sessionByTabRef.current.get(tabId);
    if (sessionId) void serverWrite(sessionId, ENCODER.encode(data)).catch(() => {});
  }, []);

  const sendResize = useCallback((tabId: string, { cols, rows }: TerminalSize) => {
    const sessionId = sessionByTabRef.current.get(tabId);
    if (sessionId) void serverResize(sessionId, cols, rows).catch(() => {});
  }, []);

  const addTab = useCallback(() => {
    seqRef.current += 1;
    const tab = makeShellTab(seqRef.current);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    const sessionId = sessionByTabRef.current.get(tabId);
    sessionByTabRef.current.delete(tabId);
    if (sessionId) tabBySessionRef.current.delete(sessionId);
    panesRef.current.delete(tabId);
    inFlightRef.current.delete(tabId);
    if (awaitingTabRef.current === tabId) awaitingTabRef.current = null;
    if (sessionId) void serverDisconnect(sessionId).catch(() => {});

    setTabs((prev) => prev.filter((tab) => tab.id !== tabId));
    setActiveTabId((current) => {
      if (current !== tabId) return current;
      const previous = tabsRef.current;
      const index = previous.findIndex((tab) => tab.id === tabId);
      const next = previous.filter((tab) => tab.id !== tabId);
      return next[Math.min(index, next.length - 1)]?.id ?? null;
    });
  }, []);

  const reconnectTab = useCallback(
    (tabId: string) => {
      const sessionId = sessionByTabRef.current.get(tabId);
      sessionByTabRef.current.delete(tabId);
      if (sessionId) tabBySessionRef.current.delete(sessionId);
      void connectTab(tabId);
    },
    [connectTab]
  );

  const adoptConnection = useCallback(
    (outcome: ConnectOutcome) => {
      const tabId = awaitingTabRef.current;
      awaitingTabRef.current = null;
      if (!tabId || !tabsRef.current.some((tab) => tab.id === tabId)) {
        void serverDisconnect(outcome.sessionId).catch(() => {});
        return;
      }
      sessionByTabRef.current.set(tabId, outcome.sessionId);
      tabBySessionRef.current.set(outcome.sessionId, tabId);
      patchTab(tabId, {
        sessionId: outcome.sessionId,
        status: "ready",
        error: null,
        reason: null,
      });
      applyAutoWrap(tabId);
    },
    [applyAutoWrap, patchTab]
  );

  const disconnectAll = useCallback(async () => {
    epochRef.current += 1;
    const sessions = [...sessionByTabRef.current.values()];
    sessionByTabRef.current.clear();
    tabBySessionRef.current.clear();
    await Promise.allSettled(sessions.map((sessionId) => serverDisconnect(sessionId)));
    await Promise.allSettled([serverConnectionClose(profileId)]);
    setTabs((prev) =>
      prev.map((tab) => ({
        ...tab,
        sessionId: null,
        status: "idle" as ShellStatus,
        reason: null,
        error: null,
      }))
    );
  }, [profileId]);

  const reconnectAll = useCallback(() => {
    tabsRef.current.forEach((tab) => {
      if (!sessionByTabRef.current.has(tab.id)) void connectTab(tab.id);
    });
  }, [connectTab]);

  useEffect(() => {
    exposeRef.current?.({ disconnectAll, reconnectAll, adoptConnection });
    return () => exposeRef.current?.(null);
  }, [disconnectAll, reconnectAll, adoptConnection]);

  // Report the profile's aggregate state up to the server tab.
  useEffect(() => {
    const states = tabs.map((tab) => tab.status);
    const state: ConnectionState = states.includes("ready")
      ? "ready"
      : states.includes("connecting")
        ? "connecting"
        : states.includes("failed") || states.includes("exited")
          ? "failed"
          : "idle";
    onStateChangeRef.current?.(state);
  }, [tabs]);

  const describe = (failure: unknown) => {
    const key = serverErrorCodeKey(failure);
    return key ? t(key, { defaultValue: errorText(failure) }) : errorText(failure);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "group flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-[11px]",
                tab.id === activeTabId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="max-w-28 truncate">
                {t("servers.window.shell", { defaultValue: "Shell" })} {tab.seq}
              </span>
              <button
                type="button"
                className="hover:bg-foreground/10 rounded p-0.5 opacity-0 group-hover:opacity-100"
                aria-label={t("servers.window.closeShell", { defaultValue: "Close shell" })}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground size-6"
          title={t("servers.window.newShell", { defaultValue: "New shell" })}
          aria-label={t("servers.window.newShell", { defaultValue: "New shell" })}
          onClick={addTab}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const visible = tab.id === activeTabId;
          const ended = tab.status === "exited" || tab.status === "failed";
          return (
            <div key={tab.id} className={cn("absolute inset-0", !visible && "hidden")}>
              <XtermHost
                theme={theme}
                fontFamily={prefs.fontFamily}
                fontSize={prefs.fontSize}
                tabStopWidth={prefs.tabStopWidth}
                highlightCurrentLine={prefs.highlightCurrentLine}
                active={active && visible}
                autoFocus
                expose={(handle) => {
                  if (handle) {
                    panesRef.current.set(tab.id, handle);
                    void connectTab(tab.id);
                  } else {
                    panesRef.current.delete(tab.id);
                  }
                }}
                onData={(data) => sendData(tab.id, data)}
                onResize={(size) => sendResize(tab.id, size)}
              />

              {ended && (
                <div className="border-border bg-card/95 absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs shadow-sm">
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {tab.status === "exited"
                      ? (tab.reason ?? t("servers.window.disconnected"))
                      : describe(tab.error)}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => reconnectTab(tab.id)}>
                    <RefreshCw />
                    {t("servers.window.reconnect")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}

        {tabs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-muted-foreground text-xs">{t("servers.window.disconnected")}</p>
            <Button variant="secondary" size="sm" onClick={addTab}>
              <Plus className="size-4" />
              {t("servers.window.newShell", { defaultValue: "New shell" })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
