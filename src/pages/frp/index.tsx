import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useFrpWorkspace } from "@/hooks/use-frp-workspace";
import { createFrpLogStore } from "@/lib/frp/log-store";
import { cn } from "@/lib/utils";
import { OverviewTab } from "./overview-tab";
import { ServersTab } from "./servers-tab";
import { TunnelsTab } from "./tunnels-tab";
import { LogsTab } from "./logs-tab";
import { RuntimeTab } from "./runtime-tab";

type FrpTab = "overview" | "servers" | "tunnels" | "logs" | "runtime";

const TABS: { value: FrpTab; labelKey: string }[] = [
  { value: "overview", labelKey: "frp.tab.overview" },
  { value: "servers", labelKey: "frp.tab.servers" },
  { value: "tunnels", labelKey: "frp.tab.tunnels" },
  { value: "logs", labelKey: "frp.tab.logs" },
  { value: "runtime", labelKey: "frp.tab.runtime" },
];

const ACTIVE_STATES = new Set(["starting", "running", "reconnecting", "stopping"]);

/**
 * The FRP console shell: it owns loading, the event subscriptions and the tab
 * selection. Each tab is a separate component owned by its lane; nothing in
 * this file reaches into a tab's data.
 */
export default function FrpPage() {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<FrpTab>("overview");
  // Set when a "view logs" action jumps here from another tab; the logs tab
  // consumes it as its initial server filter.
  const [logProfileId, setLogProfileId] = useState<string | null>(null);

  // One ring buffer for as long as the page is mounted. The logs tab reads it
  // through `useSyncExternalStore`, so a streamed line does not re-render the
  // other four tabs.
  const logStore = useMemo(() => createFrpLogStore(), []);
  const workspace = useFrpWorkspace({ onLog: (entry) => logStore.push(entry) });

  const openLogs = (profileId: string) => {
    setLogProfileId(profileId);
    setTab("logs");
  };

  const runningCount = useMemo(
    () =>
      Object.values(workspace.snapshots).filter((snapshot) => ACTIVE_STATES.has(snapshot.state))
        .length,
    [workspace.snapshots]
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("frp.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("frp.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {t("frp.shell.summary", {
              profiles: workspace.profiles.length,
              running: runningCount,
              runtimes: workspace.runtimes.length,
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={workspace.loading}
            onClick={() => void workspace.reload()}
          >
            <RefreshCw className={workspace.loading ? "animate-spin" : undefined} />
            {t("frp.common.refresh")}
          </Button>
        </div>
      </header>

      <nav className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
        {TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={tab === option.value}
            onClick={() => setTab(option.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === option.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </nav>

      {workspace.error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{workspace.error}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={workspace.loading}
            onClick={() => void workspace.reload()}
          >
            <RefreshCw className={workspace.loading ? "animate-spin" : undefined} />
            {t("frp.common.retry")}
          </Button>
          <Button variant="ghost" size="sm" onClick={workspace.dismissError}>
            {t("frp.common.close")}
          </Button>
        </div>
      )}

      {workspace.loading && workspace.profiles.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm">
          <Loader2 className="size-6 animate-spin" />
          {t("frp.common.loading")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tab === "overview" && (
            <OverviewTab
              workspace={workspace}
              onOpenRuntime={() => setTab("runtime")}
              onOpenLogs={openLogs}
            />
          )}
          {tab === "servers" && (
            <ServersTab
              workspace={workspace}
              onOpenLogs={openLogs}
              onOpenRuntime={() => setTab("runtime")}
            />
          )}
          {tab === "tunnels" && (
            <TunnelsTab workspace={workspace} onOpenServers={() => setTab("servers")} />
          )}
          {tab === "logs" && (
            <LogsTab workspace={workspace} store={logStore} initialProfileId={logProfileId} />
          )}
          {tab === "runtime" && <RuntimeTab workspace={workspace} />}
        </div>
      )}
    </div>
  );
}
