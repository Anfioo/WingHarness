import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";
import {
  clashCoreStart,
  clashCoreStop,
  clashRuntime,
  clashSetMode,
  clashSummary,
  clashSysProxy,
  clashSysProxySet,
  type ClashRuntime,
  type ClashSummary,
  type ClashSysProxyStatus,
} from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ConnectionsTab } from "./connections";
import { HomeTab } from "./home";
import { LogsTab } from "./logs";
import { ProxiesTab } from "./proxies";
import { RulesTab } from "./rules";
import { SettingsTab } from "./settings";
import { SubscriptionsTab } from "./subscriptions";
import { TestTab } from "./test";

const RUNTIME_POLL_MS = 3000;

type TopTab =
  | "home"
  | "settings"
  | "subscriptions"
  | "proxies"
  | "rules"
  | "connections"
  | "logs"
  | "test";

export default function ClashPage() {
  const { t } = useAppTranslation();

  const [summary, setSummary] = useState<ClashSummary | null>(null);
  const [tab, setTab] = useState<TopTab>("home");
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState<ClashRuntime | null>(null);
  const [sysProxy, setSysProxy] = useState<ClashSysProxyStatus | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSummary(await clashSummary());
    } catch (error) {
      console.error("Failed to load Clash summary:", error);
    }
  }, []);

  // The core owns both pieces of runtime state, and either can change without
  // this page asking: a restart, a hot reload, another program touching the
  // registry. Polling keeps the bar honest about what is actually in force.
  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await clashRuntime());
    } catch {
      // No controller answer means no core to describe; the bar says so rather
      // than showing a mode nobody is enforcing.
      setRuntime(null);
    }
    try {
      setSysProxy(await clashSysProxy());
    } catch (error) {
      console.error("Failed to read the system proxy:", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshRuntime();
    const timer = window.setInterval(() => void refreshRuntime(), RUNTIME_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, refreshRuntime]);

  // The engine reports compile and watcher events; the page only needs to know
  // that something moved so the status line stays honest.
  useEffect(() => {
    const unlisten = listen("clash:prism", () => {
      void refresh();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [refresh]);

  const toggleCore = useCallback(async () => {
    if (!summary) return;
    setBusy(true);
    try {
      if (summary.core.running) {
        await clashCoreStop();
        toast.success(t("clash.messages.coreStopped"));
      } else {
        await clashCoreStart();
        toast.success(t("clash.messages.coreStarted"));
      }
      await refresh();
      await refreshRuntime();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [refresh, refreshRuntime, summary, t]);

  const changeMode = useCallback(
    async (mode: string) => {
      try {
        await clashSetMode(mode);
      } catch (error) {
        toast.error(String(error));
      }
      await refreshRuntime();
    },
    [refreshRuntime]
  );

  const toggleSysProxy = useCallback(
    async (enabled: boolean) => {
      setProxyBusy(true);
      try {
        await clashSysProxySet(enabled);
      } catch (error) {
        toast.error(String(error));
      } finally {
        setProxyBusy(false);
        await refreshRuntime();
      }
    },
    [refreshRuntime]
  );

  const core = summary?.core;
  const running = Boolean(core?.running);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      {/* The window's own title bar already names this page, so the page spends
          its first row on what changes: where you are and whether the core is up. */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <nav className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
          {(
            [
              { value: "home", label: t("clash.topTabs.home") },
              { value: "settings", label: t("clash.topTabs.settings") },
              { value: "subscriptions", label: t("clash.topTabs.subscriptions") },
              { value: "proxies", label: t("clash.topTabs.proxies") },
              { value: "rules", label: t("clash.topTabs.rules") },
              { value: "connections", label: t("clash.topTabs.connections") },
              { value: "logs", label: t("clash.topTabs.logs") },
              { value: "test", label: t("clash.topTabs.test") },
            ] as { value: TopTab; label: string }[]
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setTab(option.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                tab === option.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {core && !core.binary.found && (
            <Badge variant="destructive">{t("clash.core.missing")}</Badge>
          )}
          {core?.binary.found && (
            <span
              className="flex items-center gap-1.5 text-xs"
              title={running && core.pid ? `pid ${core.pid}` : undefined}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  running ? "bg-emerald-500" : "bg-muted-foreground/40"
                )}
              />
              <span className={running ? "text-foreground" : "text-muted-foreground"}>
                {running ? t("clash.core.running") : t("clash.core.stopped")}
              </span>
              {running && core.pid ? (
                <span className="text-muted-foreground/70 font-mono text-[11px]">{core.pid}</span>
              ) : null}
            </span>
          )}
          {core && running && !core.apiReachable && (
            // The process is alive but its REST API is not: usually a controller
            // port another Clash client got to first. Say so here instead of
            // letting the proxies tab fail with a bare 401.
            <Badge variant="destructive" title={core.apiError ?? undefined}>
              {t("clash.core.apiUnavailable")}
            </Badge>
          )}
          <Button
            size="sm"
            variant={running ? "outline" : "default"}
            disabled={busy || !core}
            onClick={toggleCore}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : running ? (
              <Square className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
            {running ? t("clash.actions.stop") : t("clash.actions.start")}
          </Button>
        </div>
      </header>

      {/* The mode switch and the system proxy switch are both properties of the
          running core; the home page is where the user sees its state, so both
          live there rather than in a bar on every tab. */}

      {tab === "home" && (
        <HomeTab
          running={running}
          mode={runtime?.mode ?? null}
          sysProxy={sysProxy}
          proxyBusy={proxyBusy}
          coreVersion={core?.binary.version ?? null}
          mixedPort={runtime?.mixedPort ?? null}
          onToggleSysProxy={toggleSysProxy}
          onChangeMode={changeMode}
          onOpenProxies={() => setTab("proxies")}
        />
      )}
      {/* Kept mounted: an unsaved edit survives a trip to another tab. */}
      <div className={cn("flex min-h-0 flex-1", tab !== "settings" && "hidden")}>
        <SettingsTab summary={summary} refresh={refresh} />
      </div>
      {tab === "subscriptions" && (
        <SubscriptionsTab
          activeProfile={summary?.activeProfile ?? null}
          profiles={summary?.profiles ?? []}
          refresh={refresh}
        />
      )}
      {tab === "proxies" && (
        <ProxiesTab running={running} mode={runtime?.mode ?? null} onChangeMode={changeMode} />
      )}
      {tab === "rules" && <RulesTab running={running} />}
      {tab === "connections" && <ConnectionsTab running={running} />}
      {tab === "logs" && <LogsTab />}
      {/* Kept mounted: test results are local state and would otherwise be lost
          every time the user looks at another tab. */}
      <div className={cn("flex min-h-0 flex-1", tab !== "test" && "hidden")}>
        <TestTab running={running} />
      </div>
    </div>
  );
}
