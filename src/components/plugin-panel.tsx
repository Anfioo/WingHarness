import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, Loader2, Package, Play, Square } from "lucide-react";
import { toast } from "sonner";
import {
  pluginsOpenLog,
  pluginsProbe,
  pluginsStart,
  pluginsStop,
  type PluginView,
} from "@/commands";
import { PluginBrowser } from "@/components/plugin-browser";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** How often the page asks whether a plugin's server has opened its socket yet. */
const PROBE_INTERVAL = 400;

/** Giving up after this many tries keeps a plugin that never listens from spinning forever. */
const PROBE_ATTEMPTS = 40;

/**
 * What a plugin's pane is showing.
 *
 * `idle` is a pane the user stopped by hand; `failed` is one that never came up,
 * and both offer a button that starts it again.
 */
type Phase = "idle" | "starting" | "waiting" | "ready" | "failed";

/**
 * One plugin's page, with the controls that keep it usable inside the app.
 *
 * Starting the plugin is part of showing its page: the address in the manifest
 * is only meaningful once something is listening on it. The same pane fills a
 * tab on the plugins page, an independent window, and the focused single-plugin
 * view — `host` is what tells the backend which window this pane's native
 * webview belongs to.
 */
export function PluginPanel({
  plugin,
  active,
  up,
  known,
  onUpChanged,
  host,
}: {
  plugin: PluginView;
  active: boolean;
  /** The plugin's page answers, so it counts as running. */
  up: boolean;
  /** Whether that has been checked yet — `up: false` alone means nothing. */
  known: boolean;
  /** Re-checks the addresses, so both screens agree the moment the user starts
   *  or stops this plugin. */
  onUpChanged: () => Promise<void>;
  /** Label of the window this pane lives in; passed through to the webview. */
  host?: string;
}) {
  const { t } = useAppTranslation();
  // Same reason as the page's own ref: changing the language must not restart
  // the plugin this pane is showing.
  const translate = useRef(t);
  translate.current = t;

  const url = plugin.ui as string;

  // Stopped until asked. Visiting a tab must not launch a plugin's server by
  // itself: the user decides when something starts, and an unasked-for start
  // is a process (and a held port) they never agreed to.
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  // Bumping this starts the plugin, and starting again after a stop.
  const [attempt, setAttempt] = useState(0);
  // True while a user-pressed Stop is in flight, so the exit that follows is
  // reported as a stop rather than as a run that failed.
  const [stopping, setStopping] = useState(false);

  // Bumped to abandon a start that is still in flight. The boot below polls for
  // up to PROBE_ATTEMPTS * PROBE_INTERVAL, and a Stop pressed during that window
  // must stop the polling too — otherwise the loop would go on to declare the
  // plugin unreachable moments after the user deliberately stopped it.
  const generation = useRef(0);

  // The page answers, so it is running — show it. This covers a plugin started
  // from Settings, or one left serving by an earlier run of the app, which is
  // exactly the case the process table cannot answer. No need to probe again:
  // the check that got us here *was* the probe.
  useEffect(() => {
    if (!known || !up || phase === "ready") return;

    // Abandons any start still in flight: it has arrived, so the wait is over.
    generation.current += 1;
    setAttempt(0);
    setFailure(null);
    setPhase("ready");
  }, [known, up, phase]);

  // The reverse: it stopped answering, so stop claiming to show a live page.
  // `ready` only — a `failed` pane keeps the reason the plugin never came up,
  // which is the thing the user needs to read.
  useEffect(() => {
    if (!known || up || phase !== "ready") return;
    setPhase("idle");
  }, [known, up, phase]);

  useEffect(() => {
    // Nothing runs until the user presses Start — see the `phase` state above.
    if (attempt === 0) return;

    let unmounted = false;
    const mine = (generation.current += 1);
    const stale = () => unmounted || generation.current !== mine;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const boot = async () => {
      setFailure(null);

      // Never launch over a page that is already answering: a second copy would
      // fail to bind its port, and that failure would look like the plugin
      // being broken when it is in fact fine. `known` guards the first render,
      // where "not up" only means "not checked yet".
      const alreadyServing = known && up;
      if (alreadyServing) {
        setPhase("ready");
        return;
      }

      setPhase("starting");

      try {
        await pluginsStart(plugin.id);
      } catch (error) {
        if (stale()) return;
        setPhase("failed");
        setFailure(
          translate.current("pluginPanel.startFailed", {
            name: plugin.name,
            message: String(error),
          })
        );
        return;
      }

      if (stale()) return;
      setPhase("waiting");
      // The process exists now; let the other screens see it as soon as its
      // address answers, rather than waiting for the next poll.
      void onUpChanged();

      for (let tryCount = 0; tryCount < PROBE_ATTEMPTS; tryCount += 1) {
        try {
          if (await pluginsProbe(url)) {
            if (!stale()) setPhase("ready");
            return;
          }
        } catch (error) {
          if (stale()) return;
          setPhase("failed");
          setFailure(String(error));
          return;
        }

        await sleep(PROBE_INTERVAL);
        if (stale()) return;
      }

      if (!stale()) {
        setPhase("failed");
        setFailure(translate.current("pluginPanel.unreachable", { name: plugin.name, url }));
      }
    };

    void boot();

    return () => {
      unmounted = true;
    };
    // `known`/`up` are the state at start time: re-running the boot when the
    // probe result flips would abandon the attempt it belongs to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, plugin.name, url, attempt, onUpChanged]);

  const stop = useCallback(async () => {
    setStopping(true);
    // Abandons any start still polling for the port.
    generation.current += 1;
    try {
      await pluginsStop(plugin.id);
      toast.success(t("pluginPanel.stopped", { name: plugin.name }));
    } catch (error) {
      // The plugin is killed either way — the error is its own stop script
      // failing — so the pane still ends up stopped.
      console.error("Failed to stop a plugin:", error);
      toast.error(t("pluginPanel.stopFailed", { name: plugin.name, message: String(error) }));
    } finally {
      setStopping(false);
      setPhase("idle");
      setFailure(null);
      void onUpChanged();
    }
  }, [plugin.id, plugin.name, t, onUpChanged]);

  const openLog = useCallback(async () => {
    try {
      await pluginsOpenLog(plugin.id);
    } catch (error) {
      console.error("Failed to open a plugin log:", error);
      toast.error(t("pluginPanel.logFailed", { message: String(error) }));
    }
  }, [plugin.id, t]);

  // Whether the app has a process for this plugin right now.
  //
  // `waiting` counts: the plugin has been spawned and is taking its time to
  // bind a port, and that is exactly when the user wants to stop it. `starting`
  // does not — the spawn is still in flight, so a stop would race it.
  const running = (known && up) || phase === "ready" || phase === "waiting";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="bg-muted/20 text-muted-foreground flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
        <span className="truncate">{plugin.name}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            title={t("pluginPanel.log")}
            onClick={() => void openLog()}
          >
            <FileText className="size-3.5" />
          </Button>

          {/* One button, two jobs: it starts the plugin, and pressing it again
              stops it. */}
          <Button
            variant={running ? "outline" : "default"}
            size="sm"
            className="h-6 gap-1 px-2"
            disabled={stopping || phase === "starting"}
            onClick={() => (running ? void stop() : setAttempt((count) => count + 1))}
          >
            {running ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
            {running ? t("pluginPanel.stop") : t("pluginPanel.start")}
          </Button>
        </div>
      </div>

      {phase === "ready" ? (
        // A native webview, not an iframe: plugins send `X-Frame-Options: DENY`
        // and a cross-origin frame's address is unreadable, so an iframe could
        // neither show the page nor drive one.
        <PluginBrowser
          id={plugin.id}
          name={plugin.name}
          initialUrl={url}
          active={active}
          host={host}
        />
      ) : (
        // The action lives in the toolbar above; this area only reports state.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {phase === "failed" ? (
            <>
              <AlertTriangle className="text-destructive size-6" />
              <p className="max-w-md text-sm">{failure}</p>
              <p className="text-muted-foreground text-xs">{t("pluginPanel.retryHint")}</p>
            </>
          ) : phase === "idle" ? (
            <>
              <Package className="text-muted-foreground size-6" />
              <p className="text-muted-foreground text-sm">{t("pluginPanel.idleHint")}</p>
            </>
          ) : (
            <>
              <Loader2 className="text-muted-foreground size-6 animate-spin" />
              <p className="text-muted-foreground text-sm">
                {phase === "starting"
                  ? t("pluginPanel.starting", { name: plugin.name })
                  : t("pluginPanel.waiting", { name: plugin.name })}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
