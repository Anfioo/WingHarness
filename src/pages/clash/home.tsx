import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Globe,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";
import {
  clashConnections,
  clashCoreMetrics,
  clashIpInfo,
  clashProxies,
  clashRules,
  type ClashConnectionsView,
  type ClashCoreMetrics,
  type ClashIpInfo,
  type ClashProxiesView,
  type ClashRulesView,
  type ClashSysProxyStatus,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { displayNode, protocolLabel, toneClass, useObservedNode } from "./nodes";
import { Segmented, formatBytes } from "./shared";
import { TrafficChart, type TrafficPoint } from "./traffic-chart";

/** The controller answers this fast enough to gauge speed by differencing it. */
const POLL_MS = 1000;
/** Ten minutes of one-second samples, the widest window the chart offers. */
const MAX_SAMPLES = 600;
const RULES_POLL_TICKS = 30;
const IP_REFRESH_SECONDS = 300;

type Range = "one" | "five" | "ten";

const RANGE_MS: Record<Range, number> = {
  one: 60_000,
  five: 300_000,
  ten: 600_000,
};

export function HomeTab({
  running,
  mode,
  sysProxy,
  proxyBusy,
  coreVersion,
  mixedPort,
  onToggleSysProxy,
  onChangeMode,
  onOpenProxies,
}: {
  running: boolean;
  /** `rule` | `global` | `direct`; null while the core cannot be asked. */
  mode: string | null;
  sysProxy: ClashSysProxyStatus | null;
  proxyBusy: boolean;
  /** The binary's version string, without the engine name. */
  coreVersion: string | null;
  mixedPort: number | null;
  onToggleSysProxy: (enabled: boolean) => void;
  onChangeMode: (mode: string) => void;
  onOpenProxies: () => void;
}) {
  const { t } = useAppTranslation();

  const [proxies, setProxies] = useState<ClashProxiesView | null>(null);
  const [connections, setConnections] = useState<ClashConnectionsView | null>(null);
  const [metrics, setMetrics] = useState<ClashCoreMetrics | null>(null);
  const [rules, setRules] = useState<ClashRulesView | null>(null);
  const [samples, setSamples] = useState<TrafficPoint[]>([]);
  const [speeds, setSpeeds] = useState({ up: 0, down: 0 });
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("ten");

  /** The previous sample's totals, the base every rate is measured against. */
  const baseline = useRef<{ at: number; up: number; down: number } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let step = 0;
    let sampling = false;

    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const next = await clashConnections();
        if (!mounted.current) return;
        setConnections(next);
        setError(null);

        const now = Date.now();
        const previous = baseline.current;
        baseline.current = { at: now, up: next.uploadTotal, down: next.downloadTotal };
        if (!previous) return;

        const seconds = (now - previous.at) / 1000;
        if (seconds <= 0) return;
        const up = Math.max(0, next.uploadTotal - previous.up) / seconds;
        const down = Math.max(0, next.downloadTotal - previous.down) / seconds;
        setSpeeds({ up, down });
        setSamples((current) => {
          const trimmed = current.length >= MAX_SAMPLES ? current.slice(1) : current;
          return [...trimmed, { at: now, up, down }];
        });
      } catch (cause) {
        if (!mounted.current) return;
        // A stopped core resets its counters; keeping the old baseline would
        // report a huge burst the moment it comes back.
        baseline.current = null;
        setSpeeds({ up: 0, down: 0 });
        setSamples([]);
        setConnections(null);
        setProxies(null);
        setError(String(cause));
      } finally {
        sampling = false;
      }
    };

    const loadProxies = async () => {
      try {
        const next = await clashProxies();
        if (mounted.current) setProxies(next);
      } catch {
        if (mounted.current) setProxies(null);
      }
    };

    const loadMetrics = async () => {
      try {
        const next = await clashCoreMetrics();
        if (mounted.current) setMetrics(next);
      } catch {
        if (mounted.current) setMetrics(null);
      }
    };

    const loadRules = async () => {
      try {
        const next = await clashRules();
        if (mounted.current) setRules(next);
      } catch {
        if (mounted.current) setRules(null);
      }
    };

    void sample();
    void loadProxies();
    void loadMetrics();
    void loadRules();

    const timer = window.setInterval(() => {
      step += 1;
      void sample();
      void loadMetrics();
      if (step % 2 === 0) void loadProxies();
      if (step % RULES_POLL_TICKS === 0) void loadRules();
    }, POLL_MS);

    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);

  // ── Exit address ─────────────────────────────────────────────────────────

  const [ip, setIp] = useState<ClashIpInfo | null>(null);
  const [ipError, setIpError] = useState<string | null>(null);
  const [ipBusy, setIpBusy] = useState(false);
  const [ipNonce, setIpNonce] = useState(0);
  const [ipRemaining, setIpRemaining] = useState(IP_REFRESH_SECONDS);
  const [ipRevealed, setIpRevealed] = useState(false);
  const ipRemainingRef = useRef(IP_REFRESH_SECONDS);

  const refreshIp = useCallback(() => {
    ipRemainingRef.current = IP_REFRESH_SECONDS;
    setIpRemaining(IP_REFRESH_SECONDS);
    setIpNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIpBusy(true);
    clashIpInfo()
      .then((next) => {
        if (cancelled) return;
        setIp(next);
        setIpError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setIpError(String(cause));
      })
      .finally(() => {
        if (cancelled) return;
        setIpBusy(false);
        ipRemainingRef.current = IP_REFRESH_SECONDS;
        setIpRemaining(IP_REFRESH_SECONDS);
      });
    return () => {
      cancelled = true;
    };
  }, [ipNonce]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      ipRemainingRef.current -= 1;
      if (ipRemainingRef.current <= 0) {
        ipRemainingRef.current = IP_REFRESH_SECONDS;
        setIpNonce((value) => value + 1);
      }
      setIpRemaining(Math.max(0, ipRemainingRef.current));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // ── Derived values ───────────────────────────────────────────────────────

  const confirmed = useObservedNode(connections?.connections ?? [], proxies);
  const current = displayNode(proxies, confirmed);
  const delay = current?.delay ?? null;
  const activeConnections = connections?.connections.length ?? null;

  const proxyOn = Boolean(sysProxy?.enabled);
  const canToggleProxy = Boolean(sysProxy?.supported) && (running || proxyOn);
  const proxyText = !sysProxy?.supported
    ? t("clash.runtime.unsupported")
    : proxyOn
      ? t("clash.runtime.protected")
      : running
        ? t("clash.runtime.inactive")
        : t("clash.runtime.enableHint");

  const location = [ip?.region, ip?.city].filter(Boolean).join(", ");
  const coordinates =
    ip && ip.longitude !== null && ip.latitude !== null
      ? `${ip.countryCode}, ${ip.longitude.toFixed(2)}, ${ip.latitude.toFixed(2)}`
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-3 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">{t("clash.runtime.mode")}</span>
            {mode ? (
              <Segmented
                value={mode}
                options={[
                  { value: "rule", label: t("clash.runtime.modes.rule") },
                  { value: "global", label: t("clash.runtime.modes.global") },
                  { value: "direct", label: t("clash.runtime.modes.direct") },
                ]}
                onChange={onChangeMode}
              />
            ) : (
              <span className="text-muted-foreground/70 text-xs">
                {t("clash.runtime.modeOffline")}
              </span>
            )}
          </div>

          {(error || !running) && (
            <div className="text-muted-foreground bg-muted/30 flex items-center gap-2 rounded-md border border-dashed px-3 py-2.5 text-xs">
              <PowerOff className="size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {running ? error : t("clash.home.coreOffline")}
              </span>
            </div>
          )}

          <section className="bg-card/40 rounded-lg border px-3.5 py-3">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium">{t("clash.home.trafficStats")}</span>
              <Segmented
                value={range}
                options={[
                  { value: "one", label: t("clash.home.ranges.one") },
                  { value: "five", label: t("clash.home.ranges.five") },
                  { value: "ten", label: t("clash.home.ranges.ten") },
                ]}
                onChange={setRange}
              />
            </div>
            <div className="mt-2">
              <TrafficChart
                points={samples}
                rangeMs={RANGE_MS[range]}
                precise={range === "one"}
                labels={{
                  waiting: running ? t("clash.home.sampling") : t("clash.home.noData"),
                  upload: t("clash.home.uploadSpeed"),
                  download: t("clash.home.downloadSpeed"),
                }}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Tile
                label={t("clash.home.uploadSpeed")}
                value={connections ? `${formatBytes(speeds.up)}/s` : "—"}
                tone="up"
              />
              <Tile
                label={t("clash.home.downloadSpeed")}
                value={connections ? `${formatBytes(speeds.down)}/s` : "—"}
                tone="down"
              />
              <Tile label={t("clash.home.activeConnections")} value={activeConnections ?? "—"} />
              <Tile
                label={t("clash.home.uploaded")}
                value={connections ? formatBytes(connections.uploadTotal) : "—"}
              />
              <Tile
                label={t("clash.home.downloaded")}
                value={connections ? formatBytes(connections.downloadTotal) : "—"}
              />
              <Tile
                label={t("clash.home.memory")}
                value={metrics?.memory != null ? formatBytes(metrics.memory) : "—"}
              />
            </div>
          </section>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="bg-card/40 rounded-lg border px-3.5 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-muted-foreground text-xs">{t("clash.home.currentNode")}</div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="truncate text-base font-semibold">{current?.name ?? "—"}</span>
                    {current && (
                      <span className="text-muted-foreground text-sm">
                        {protocolLabel(current.kind)}
                      </span>
                    )}
                    <span
                      className={cn(
                        "ml-auto font-mono text-sm tabular-nums",
                        toneClass({ alive: current?.alive ?? true, delay })
                      )}
                    >
                      {delay === null ? "—" : `${delay} ms`}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-0.5 truncate text-xs">
                    {!running
                      ? t("clash.home.coreOffline")
                      : current?.group
                        ? t("clash.home.via", { name: current.group })
                        : t("clash.home.noTraffic")}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={onOpenProxies}>
                  {t("clash.home.openProxies")}
                  <ArrowRight className="size-3.5" />
                </Button>
              </div>
            </section>

            <section className="bg-card/40 flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-3">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md",
                  proxyOn
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted/70 text-muted-foreground"
                )}
              >
                {proxyOn ? <ShieldCheck className="size-4" /> : <ShieldOff className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t("clash.runtime.sysProxy")}</div>
                <div
                  className={cn(
                    "mt-0.5 truncate text-xs",
                    proxyOn ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {proxyText}
                </div>
              </div>
              {proxyOn && sysProxy?.server && (
                <span className="text-muted-foreground/70 shrink-0 font-mono text-[11px]">
                  {sysProxy.server}
                </span>
              )}
              <Switch
                checked={proxyOn}
                disabled={proxyBusy || !canToggleProxy}
                onCheckedChange={onToggleSysProxy}
                aria-label={t("clash.runtime.sysProxy")}
              />
            </section>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="bg-card/40 rounded-lg border px-3.5 py-3">
              <CardTitle icon={ShieldCheck}>{t("clash.home.clashInfo")}</CardTitle>
              <dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-xs">
                <InfoRow label={t("clash.home.coreVersion")} value={coreVersion ?? "—"} />
                <InfoRow
                  label={t("clash.home.systemProxyAddress")}
                  value={sysProxy?.server ?? "—"}
                />
                <InfoRow label={t("clash.home.mixedPort")} value={mixedPort ?? "—"} />
                <InfoRow
                  label={t("clash.home.uptime")}
                  value={metrics?.uptimeMs != null ? formatUptime(metrics.uptimeMs) : "—"}
                />
                <InfoRow label={t("clash.home.rulesCount")} value={rules?.rules.length ?? "—"} />
              </dl>
            </section>

            <section className="bg-card/40 rounded-lg border px-3.5 py-3">
              <div className="flex items-center gap-1.5">
                <Globe className="text-muted-foreground size-4" />
                <span className="text-sm font-medium">{t("clash.home.ipInfo")}</span>
                {ip && (
                  <span className="text-muted-foreground text-xs">
                    {ip.country || ip.countryCode}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    title={ipRevealed ? t("clash.home.hideIp") : t("clash.home.revealIp")}
                    onClick={() => setIpRevealed((value) => !value)}
                  >
                    {ipRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    title={t("clash.home.refresh")}
                    disabled={ipBusy}
                    onClick={refreshIp}
                  >
                    <RefreshCw className={cn("size-3.5", ipBusy && "animate-spin")} />
                  </Button>
                </div>
              </div>

              {ip ? (
                <dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-xs">
                  <InfoRow
                    label={t("clash.home.ipIsp")}
                    value={ip.organization || ip.asnOrganization || t("clash.home.ipUnknown")}
                  />
                  <InfoRow label="IP" value={ipRevealed ? ip.ip : maskIp(ip.ip)} />
                  <InfoRow
                    label={t("clash.home.ipLocation")}
                    value={location || t("clash.home.ipUnknown")}
                  />
                  <InfoRow
                    label={t("clash.home.ipAsn")}
                    value={
                      ip.asn === null ? (
                        t("clash.home.ipUnknown")
                      ) : (
                        <span title={ip.asnOrganization || undefined}>AS{ip.asn}</span>
                      )
                    }
                  />
                  <InfoRow
                    label={t("clash.home.ipTimezone")}
                    value={ip.timezone || t("clash.home.ipUnknown")}
                  />
                </dl>
              ) : (
                <p className="text-muted-foreground mt-2 text-xs">
                  {ipError ? t("clash.home.ipFailed") : t("clash.home.ipLoading")}
                </p>
              )}

              <div className="text-muted-foreground/70 mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums">
                <span>{t("clash.home.ipAutoRefresh", { seconds: ipRemaining })}</span>
                <span>{coordinates ?? ""}</span>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="bg-muted/30 rounded-md border px-3 py-2">
      <div className="text-muted-foreground truncate text-[11px]">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate font-mono text-sm font-medium tabular-nums",
          tone === "up" && "text-emerald-600 dark:text-emerald-400",
          tone === "down" && "text-sky-600 dark:text-sky-400"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function CardTitle({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="text-muted-foreground size-4" />
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono tabular-nums">{value}</dd>
    </>
  );
}

/** `0:01:08` — hours are not padded, minutes and seconds are. */
function formatUptime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Enough of an address to recognise it, not enough to be worth copying. */
function maskIp(ip: string): string {
  const v4 = ip.split(".");
  if (v4.length === 4) return `${v4[0]}.${v4[1]}.*.*`;
  const v6 = ip.split(":");
  if (v6.length > 2) return `${v6[0]}:${v6[1]}:****`;
  return "••••";
}
