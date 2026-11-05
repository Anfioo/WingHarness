import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, FolderTree, RefreshCw, SquareTerminal, Unplug } from "lucide-react";
import {
  serverErrorCode,
  type ConnectionState,
  type ServerProfile,
} from "@/commands/services/servers/types";
import { HostKeyDialog, type HostKeyRequest } from "@/components/servers/host-key-dialog";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { errorText, formatEndpoint, serverErrorCodeKey } from "@/lib/servers/format";
import { cn } from "@/lib/utils";
import { loadTerminalPrefs, type TerminalPrefs } from "@/pages/local-terminal/prefs";
import { SshTab, type SshTabHandle } from "./ssh-tab";
import SftpTab from "./sftp-tab";
import { MetricsTab } from "./metrics-tab";

const TERMINAL_PREFS_KEY = "local-terminal-prefs";

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

export type ServerTabProps = {
  profile: ServerProfile;
  /** This server's top-level tab is the visible one. */
  active: boolean;
  onStateChange?: (profileId: string, state: ConnectionState) => void;
};

/**
 * One server: the connection header, and the terminal / XFTP / metrics views.
 *
 * The terminal stays mounted for as long as the server tab lives (hidden when
 * another view is shown) so xterm keeps its scrollback. XFTP and metrics are
 * mounted on first use only, so opening a server costs one shell connection
 * and nothing else.
 */
export function ServerTab({ profile, active, onStateChange }: ServerTabProps) {
  const { t } = useAppTranslation();

  const [view, setView] = useState<"terminal" | "sftp" | "metrics">("terminal");
  const [sftpMounted, setSftpMounted] = useState(false);
  const [metricsMounted, setMetricsMounted] = useState(false);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<unknown>(null);
  const [hostKey, setHostKey] = useState<HostKeyRequest | null>(null);
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => loadTerminalPrefs());
  const sshRef = useRef<SshTabHandle | null>(null);

  // Settings are edited in the main window; `storage` is the cross-window
  // signal that they changed.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === TERMINAL_PREFS_KEY) {
        setPrefs(loadTerminalPrefs());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handleState = useCallback(
    (next: ConnectionState) => {
      setState(next);
      if (next === "connecting" || next === "ready") setError(null);
      onStateChange?.(profile.id, next);
    },
    [onStateChange, profile.id]
  );

  const handleHostKey = useCallback(
    (request: HostKeyRequest) => {
      setHostKey({ ...request, host: profile.host, port: profile.port });
    },
    [profile.host, profile.port]
  );

  const describe = (failure: unknown) => {
    const key = serverErrorCodeKey(failure);
    return key ? t(key, { defaultValue: errorText(failure) }) : errorText(failure);
  };

  const openSftp = () => {
    setSftpMounted(true);
    setView("sftp");
  };

  const openMetrics = () => {
    setMetricsMounted(true);
    setView("metrics");
  };

  const errorCode = error === null ? null : serverErrorCode(error);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {formatEndpoint(profile.host, profile.port, profile.username)}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-[11px] font-medium",
            STATE_TEXT[state]
          )}
        >
          <span className={cn("size-1.5 rounded-full", STATE_DOT[state])} />
          {t(`servers.connection.${state}`)}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={state === "idle" || state === "connecting"}
            onClick={() => void sshRef.current?.disconnectAll()}
          >
            <Unplug />
            {t("servers.window.disconnect", { defaultValue: "Disconnect" })}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => sshRef.current?.reconnectAll()}>
            <RefreshCw />
            {t("servers.window.reconnect")}
          </Button>

          <div className="bg-muted ml-1 flex items-center rounded-md p-0.5">
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                view === "terminal"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setView("terminal")}
            >
              <SquareTerminal className="size-3" />
              {t("servers.window.tab.terminal")}
            </button>
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                view === "sftp"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={openSftp}
            >
              <FolderTree className="size-3" />
              {t("servers.window.tab.sftp")}
            </button>
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                view === "metrics"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={openMetrics}
            >
              <Activity className="size-3" />
              {t("servers.window.tab.metrics")}
            </button>
          </div>
        </div>
      </header>

      {error !== null && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-xs">
          {errorCode && <span className="shrink-0 font-mono">{errorCode}</span>}
          <span className="min-w-0 flex-1 break-all">{describe(error)}</span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {/* Hidden, not unmounted: xterm cannot restore its buffer after a remount. */}
        <div className={cn("h-full", view !== "terminal" && "hidden")}>
          <SshTab
            profileId={profile.id}
            active={active && view === "terminal"}
            prefs={prefs}
            onStateChange={handleState}
            onError={(failure) => setError(failure)}
            onHostKeyRequired={handleHostKey}
            expose={(handle) => {
              sshRef.current = handle;
            }}
          />
        </div>

        {sftpMounted && (
          <div className={cn("h-full", view !== "sftp" && "hidden")}>
            <SftpTab profileId={profile.id} active={active && view === "sftp"} />
          </div>
        )}

        {metricsMounted && (
          <div className={cn("h-full", view !== "metrics" && "hidden")}>
            <MetricsTab profileId={profile.id} />
          </div>
        )}
      </div>

      <HostKeyDialog
        request={hostKey}
        onOpenChange={(open) => {
          if (!open) setHostKey(null);
        }}
        onTrusted={(outcome) => sshRef.current?.adoptConnection(outcome)}
        onForgotten={() => setHostKey(null)}
        onFailed={(failure) => setError(failure)}
      />
    </div>
  );
}
