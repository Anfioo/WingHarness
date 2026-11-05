import { useCallback, useEffect, useState } from "react";
import { Blocks, Loader2, Power, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  mcphubEndpointInfo,
  mcphubRegenerateCache,
  mcphubSetMode,
  mcphubStart,
  mcphubStatus,
  mcphubStop,
  type EndpointInfo,
  type McpHubMode,
  type McpHubStatus,
} from "@/commands";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ServersTab } from "./servers-tab";
import { ToolsTab } from "./tools-tab";
import { LogsTab } from "./logs-tab";
import { TokensTab } from "./tokens-tab";
import { MetricsTab } from "./metrics-tab";
import { SettingsTab } from "./settings-tab";

type TabId = "servers" | "tools" | "logs" | "tokens" | "metrics" | "settings";

/** Default SSE port; mirrors `mcphub::state::DEFAULT_SSE_PORT` on the backend. */
const DEFAULT_SSE_PORT = 24680;

function formatUptime(ms: number, t: (key: string, vars?: Record<string, unknown>) => string) {
  if (ms < 60_000) return t("mcphub.uptimeSeconds", { seconds: Math.floor(ms / 1000) });
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return t("mcphub.uptimeFormat", { hours, minutes: minutes % 60 });
}

function StatCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-sm font-medium">{value}</span>
      {hint && <span className="text-muted-foreground text-[10px]">{hint}</span>}
    </div>
  );
}

export default function McpHubPage() {
  const { t } = useAppTranslation();

  const [status, setStatus] = useState<McpHubStatus | null>(null);
  const [endpoint, setEndpoint] = useState<EndpointInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [tab, setTab] = useState<TabId>("servers");

  const refresh = useCallback(
    async (announce = false) => {
      try {
        const [s, e] = await Promise.all([mcphubStatus(), mcphubEndpointInfo()]);
        setStatus(s);
        setEndpoint(e);
        if (announce) toast.success(t("mcphub.loaded") ?? "Refreshed.");
      } catch (error) {
        console.error("mcphub status:", error);
        toast.error(t("mcphub.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggleRun = useCallback(async () => {
    if (!status) return;
    setToggling(true);
    try {
      if (status.running) {
        await mcphubStop();
        toast.success(t("mcphub.stoppedHub"));
      } else {
        await mcphubStart();
        toast.success(t("mcphub.started"));
      }
      await refresh();
    } catch (error) {
      console.error("mcphub toggle:", error);
      toast.error(status.running ? t("mcphub.stopFailed") : t("mcphub.startFailed"));
    } finally {
      setToggling(false);
    }
  }, [refresh, status, t]);

  const handleRegenerate = useCallback(async () => {
    try {
      await mcphubRegenerateCache();
      toast.success(t("mcphub.regenerated"));
    } catch (error) {
      console.error("mcphub regenerate:", error);
      toast.error(t("mcphub.regenerateFailed"));
    }
  }, [t]);

  const handleModeChange = useCallback(
    async (mode: McpHubMode) => {
      const previous = status?.mode;
      // Optimistic: the mode round-trips through config.json and a hot-reload.
      setStatus((prev) => (prev ? { ...prev, mode } : prev));
      try {
        await mcphubSetMode(mode);
        toast.success(t("mcphub.modeChanged"));
      } catch (error) {
        console.error("mcphub set mode:", error);
        setStatus((prev) => (prev && previous ? { ...prev, mode: previous } : prev));
        toast.error(t("mcphub.modeChangeFailed"));
      }
    },
    [status?.mode, t]
  );

  // Tokens saved: discover avoids re-sending every tool definition (~80 tokens
  // each) and only pays a fixed ~160 token meta-tool overhead.
  const toolCount = status?.toolCount ?? 0;
  const isDiscover = status?.mode === "discover";
  const tokensSaved = isDiscover ? Math.max(0, toolCount * 80 - 160) : 0;
  const tokensSavedValue =
    tokensSaved >= 1000 ? `${(tokensSaved / 1000).toFixed(1)}k` : String(tokensSaved);
  const tokensSavedHint = isDiscover
    ? t("mcphub.tokensSavedHint")
    : t("mcphub.tokensSavedPassthrough");

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "servers", label: t("mcphub.tabs.servers") },
    { id: "tools", label: t("mcphub.tabs.tools") },
    { id: "logs", label: t("mcphub.tabs.logs") },
    { id: "tokens", label: t("mcphub.tabs.tokens") },
    { id: "metrics", label: t("mcphub.tabs.metrics") },
    { id: "settings", label: t("mcphub.tabs.settings") },
  ];

  return (
    <AppShell>
      <section className="flex h-full w-full flex-col gap-4">
        {/* Status card */}
        <div className="border-border bg-card text-card-foreground rounded-xl border p-5 shadow-sm">
          {loading ? (
            <div className="flex h-24 items-center justify-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t("mcphub.loading")}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                    status?.running
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      status?.running ? "bg-emerald-500" : "bg-muted-foreground"
                    )}
                  />
                  {status?.running ? t("mcphub.running") : t("mcphub.stopped")}
                </span>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">{t("mcphub.sseUrl")}:</span>
                  <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                    {endpoint?.sseUrl ?? `http://127.0.0.1:${status?.port ?? DEFAULT_SSE_PORT}/sse`}
                  </code>
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <Select
                    value={status?.mode}
                    onValueChange={(v) => void handleModeChange(v as McpHubMode)}
                    disabled={!status?.running}
                  >
                    <SelectTrigger size="sm" className="w-56">
                      <SelectValue placeholder={t("mcphub.mode")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="discover">{t("mcphub.modeDiscover")}</SelectItem>
                      <SelectItem value="passthrough">{t("mcphub.modePassthrough")}</SelectItem>
                    </SelectContent>
                  </Select>

                  <Button
                    variant={status?.running ? "outline" : "default"}
                    size="sm"
                    onClick={() => void handleToggleRun()}
                    disabled={toggling}
                  >
                    <Power className="size-4" />
                    {toggling
                      ? status?.running
                        ? t("mcphub.stopping")
                        : t("mcphub.starting")
                      : status?.running
                        ? t("mcphub.stop")
                        : t("mcphub.start")}
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refresh(true)}
                    disabled={loading || toggling}
                  >
                    <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                  </Button>
                </div>
              </div>

              <div className="border-border grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-3 lg:grid-cols-5">
                <StatCell label={t("mcphub.statPort")} value={String(status?.port ?? "-")} />
                <StatCell
                  label={t("mcphub.statServers")}
                  value={String(status?.serverCount ?? 0)}
                />
                <StatCell label={t("mcphub.statTools")} value={String(toolCount)} />
                <StatCell
                  label={t("mcphub.statUptime")}
                  value={status?.running ? formatUptime(status.uptimeMs, t) : "—"}
                />
                <StatCell
                  label={t("mcphub.statTokensSaved")}
                  value={tokensSavedValue}
                  hint={tokensSavedHint}
                />
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="border-border bg-card text-card-foreground flex min-h-0 flex-1 flex-col rounded-xl border shadow-sm">
          <div className="border-border flex h-11 shrink-0 items-center gap-1 border-b px-2">
            {tabs.map((tabDef) => (
              <button
                key={tabDef.id}
                type="button"
                onClick={() => setTab(tabDef.id)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === tabDef.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {tabDef.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1 pr-1">
              {tab === "servers" && (
                <Button variant="ghost" size="sm" onClick={() => void handleRegenerate()}>
                  <Blocks className="size-4" />
                  {t("mcphub.regenerateCache")}
                </Button>
              )}
              {tab === "logs" && (
                <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                  <RefreshCw className="size-4" />
                  {t("mcphub.logs.refresh")}
                </Button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {tab === "servers" && <ServersTab onChanged={() => void refresh()} />}
            {tab === "tools" && <ToolsTab />}
            {tab === "logs" && <LogsTab />}
            {tab === "tokens" && <TokensTab />}
            {tab === "metrics" && <MetricsTab />}
            {tab === "settings" && <SettingsTab />}
          </div>
        </div>
      </section>
    </AppShell>
  );
}
