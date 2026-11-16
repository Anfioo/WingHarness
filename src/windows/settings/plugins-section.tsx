import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  FileText,
  FolderOpen,
  Play,
  PlayCircle,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  pluginsInstall,
  pluginsList,
  pluginsOpenDir,
  pluginsOpenLog,
  pluginsRun,
  pluginsRunAll,
  pluginsSetEnabled,
  pluginsStop,
  pluginsUninstall,
  pluginsUpdate,
  type PluginOutputEvent,
  type PluginView,
} from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { OutputPanel, type OutputLine, type RunStatus } from "@/components/output-panel";
import { createWindow } from "@/lib/window";
import { encodeLabelId } from "@/lib/plugin-label";
import { usePluginsUp } from "@/hooks/use-plugins-up";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/**
 * The one marker that tells this app's plugins apart from every other Scoop
 * app, mirroring `manifest::PLUGIN_PREFIX` in the backend.
 */
const PLUGIN_PREFIX = "wingharness-";

export function PluginsSection() {
  const { t } = useAppTranslation();
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  // The plugin whose output the panel is showing, if any. This is **not** a
  // lock: a plugin that serves a page streams for as long as it runs, so
  // treating it as "busy" would freeze every other card for hours.
  const [streaming, setStreaming] = useState<string | null>(null);
  // A Scoop lifecycle step (install, update, uninstall) is in flight: the app
  // id it is working on. It owns the output panel for its duration, and the
  // cards stay out of its way.
  const [busyId, setBusyId] = useState<string | null>(null);
  // Which stream owns the panel. A run started later takes it over, and the
  // older run's late lines are dropped rather than interleaved.
  const streamSeq = useRef(0);
  const [pendingRemove, setPendingRemove] = useState<PluginView | null>(null);
  // The install dialog's app name. `null` while the dialog is closed.
  const [installApp, setInstallApp] = useState<string | null>(null);

  const [lines, setLines] = useState<OutputLine[]>([]);
  const [status, setStatus] = useState<RunStatus>({ kind: "idle" });
  const nextLineId = useRef(0);
  // Which plugins are up, decided by whether each one's address answers. The
  // panel state above cannot answer this on its own: it only knows what this
  // window started watching, and a plugin can be serving from a run this app
  // never started.
  const { up, refresh: refreshUp } = usePluginsUp(plugins ?? []);
  // Set while a user-pressed Stop is in flight, so the exit that follows is
  // reported as a stop rather than as a run that failed.
  const stopping = useRef(false);

  const reload = useCallback(async () => {
    try {
      setPlugins(await pluginsList());
    } catch (error) {
      console.error("Failed to load plugins:", error);
      toast.error(t("plugins.loadFailed"));
      setPlugins([]);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const append = useCallback((stream: "stdout" | "stderr", text: string) => {
    const line = { id: nextLineId.current++, stream, text };
    setLines((current) => [...current, line]);
  }, []);

  const handleEvent = useCallback(
    (event: PluginOutputEvent, mine: number) => {
      // A run that was superseded keeps streaming until its process exits; its
      // output must not land in a panel now showing someone else's.
      if (mine !== streamSeq.current) return;

      if (event.kind === "line") {
        append(event.stream, event.text);
        return;
      }

      setStreaming(null);
      if (event.kind === "failed") {
        append("stderr", event.message);
        setStatus({ kind: "done", code: -1 });
        toast.error(event.message);
        return;
      }

      setStatus({ kind: "done", code: event.code });

      // A stopped plugin exits with whatever `taskkill` leaves behind, which is
      // never 0. Reporting that as a failure would be wrong: the user asked for
      // it.
      if (stopping.current) {
        stopping.current = false;
        append("stdout", t("plugins.stoppedLine"));
        return;
      }

      if (event.code === 0) {
        toast.success(t("plugins.runFinished", { code: event.code }));
      } else {
        toast.error(t("plugins.runFinished", { code: event.code }));
      }
    },
    [append, t]
  );

  const start = useCallback((label: string, run: (mine: number) => Promise<void>) => {
    const mine = (streamSeq.current += 1);
    setLines([]);
    setStatus({ kind: "running" });
    setStreaming(label);
    run(mine).catch((error: unknown) => {
      if (mine !== streamSeq.current) return;
      console.error("Failed to start a plugin:", error);
      toast.error(String(error));
      setStreaming(null);
      setStatus({ kind: "idle" });
    });
  }, []);

  /**
   * Runs one Scoop lifecycle step, streaming its output into the panel.
   *
   * The step reports success through its promise rather than through the
   * stream's closing event: the command sends `done` and then resolves, so one
   * toast per step is enough.
   */
  const lifecycleStep = useCallback(
    (
      label: string,
      success: string,
      run: (handle: (event: PluginOutputEvent) => void) => Promise<unknown>
    ) => {
      const mine = (streamSeq.current += 1);
      setLines([]);
      setStatus({ kind: "running" });
      setBusyId(label);

      const handle = (event: PluginOutputEvent) => {
        if (mine !== streamSeq.current) return;
        if (event.kind === "line") append(event.stream, event.text);
        else if (event.kind === "failed") append("stderr", event.message);
      };

      run(handle)
        .then(() => {
          if (mine !== streamSeq.current) return;
          toast.success(success);
          setStatus({ kind: "done", code: 0 });
        })
        .catch((error: unknown) => {
          if (mine !== streamSeq.current) return;
          console.error(`Failed to run the plugin step "${label}":`, error);
          toast.error(String(error));
          setStatus({ kind: "done", code: -1 });
        })
        .finally(() => {
          if (mine !== streamSeq.current) return;
          setBusyId(null);
          void reload();
        });
    },
    [append, reload]
  );

  const runOne = useCallback(
    (plugin: PluginView) => {
      stopping.current = false;
      start(plugin.id, (mine) => pluginsRun(plugin.id, (event) => handleEvent(event, mine)));
    },
    [handleEvent, start]
  );

  const stopOne = useCallback(
    async (plugin: PluginView) => {
      stopping.current = true;
      try {
        await pluginsStop(plugin.id);
        toast.success(t("plugins.stopped", { name: plugin.name }));
      } catch (error) {
        // The plugin is killed either way — the error is its own stop script
        // failing — so the run still ends.
        console.error("Failed to stop a plugin:", error);
        toast.error(t("plugins.stopFailed", { name: plugin.name, message: String(error) }));
      } finally {
        // The card must flip back to "Run" once the address stops answering,
        // rather than on the next poll.
        void refreshUp();
      }
    },
    [t, refreshUp]
  );

  const runEverything = useCallback(() => {
    stopping.current = false;
    start("all", (mine) => pluginsRunAll((event) => handleEvent(event, mine)));
  }, [handleEvent, start]);

  const install = useCallback(() => {
    const app = (installApp ?? "").trim();
    if (!app) return;

    // The backend refuses an unprefixed name too; this only turns that refusal
    // into a sentence the dialog can say before closing itself.
    if (!app.startsWith(PLUGIN_PREFIX)) {
      toast.error(t("plugins.prefixRequired", { prefix: PLUGIN_PREFIX }));
      return;
    }

    setInstallApp(null);

    lifecycleStep(app, t("plugins.installed", { name: app }), (handle) =>
      pluginsInstall(app, handle)
    );
  }, [installApp, lifecycleStep, t]);

  const update = useCallback(
    (plugin: PluginView) => {
      lifecycleStep(plugin.id, t("plugins.updated", { name: plugin.name }), (handle) =>
        pluginsUpdate(plugin.id, handle)
      );
    },
    [lifecycleStep, t]
  );

  const toggleEnabled = useCallback(async (plugin: PluginView) => {
    try {
      await pluginsSetEnabled(plugin.id, !plugin.enabled);
      setPlugins(
        (current) =>
          current?.map((item) =>
            item.id === plugin.id ? { ...item, enabled: !plugin.enabled } : item
          ) ?? null
      );
    } catch (error) {
      console.error("Failed to toggle plugin:", error);
      toast.error(String(error));
    }
  }, []);

  // The label is per-plugin, so reopening the same plugin's config focuses the
  // window already showing it instead of stacking a second copy. The id is
  // encoded because a window label may not contain `.` (see `encodeLabelId`).
  const openConfig = useCallback(
    async (plugin: PluginView) => {
      await createWindow(`plugin-config-${encodeLabelId(plugin.id)}`, {
        title: t("pluginConfig.title"),
        url: `/plugin-config?id=${encodeURIComponent(plugin.id)}`,
        width: 560,
        height: 560,
        resizable: true,
        maximizable: true,
        minimizable: false,
        decorations: false,
        transparent: true,
        shadow: false,
        parent: "main",
      });
    },
    [t]
  );

  const confirmRemove = useCallback(() => {
    if (!pendingRemove) return;
    const plugin = pendingRemove;
    setPendingRemove(null);

    lifecycleStep(plugin.id, t("plugins.uninstalled", { name: plugin.name }), (handle) =>
      pluginsUninstall(plugin.id, handle)
    );
  }, [pendingRemove, lifecycleStep, t]);

  const installed = plugins ?? [];
  const enabledCount = installed.filter((plugin) => plugin.enabled).length;
  const panelRunning = streaming !== null || busyId !== null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("plugins.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("plugins.description")}</p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={runEverything} disabled={panelRunning || enabledCount === 0}>
          <PlayCircle className="size-4" />
          {t("plugins.runAll")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setInstallApp("")}
          disabled={busyId !== null}
        >
          <Plus className="size-4" />
          {t("plugins.install")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void pluginsOpenDir()}>
          <FolderOpen className="size-4" />
          {t("plugins.openDir")}
        </Button>
        {enabledCount > 0 && (
          <span className="text-muted-foreground text-xs">
            {t("plugins.enabledCount", { n: enabledCount })}
          </span>
        )}
      </div>

      {busyId !== null && <p className="text-muted-foreground text-xs">{t("plugins.working")}</p>}

      {installed.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("plugins.empty")}</p>
      )}

      <div className="space-y-3">
        {installed.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            up={up?.has(plugin.id) ?? false}
            streaming={streaming === plugin.id}
            busyId={busyId}
            onRun={() => runOne(plugin)}
            onStop={() => void stopOne(plugin)}
            onToggle={() => void toggleEnabled(plugin)}
            onConfigure={() => void openConfig(plugin)}
            onUpdate={() => update(plugin)}
            onOpenFolder={() => void pluginsOpenDir(plugin.id)}
            onOpenLog={() => void pluginsOpenLog(plugin.id)}
            onRemove={() => setPendingRemove(plugin)}
          />
        ))}
      </div>

      <OutputPanel
        title={t("plugins.output")}
        icon={Boxes}
        lines={lines}
        status={status}
        running={panelRunning}
        onClear={() => {
          setLines([]);
          setStatus({ kind: "idle" });
        }}
        placeholder={t("plugins.outputPlaceholder")}
      />

      <Dialog
        open={installApp !== null}
        onOpenChange={(open) => !open && busyId === null && setInstallApp(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("plugins.installTitle")}</DialogTitle>
            <DialogDescription>{t("plugins.installHint")}</DialogDescription>
          </DialogHeader>

          <Input
            autoFocus
            value={installApp ?? ""}
            placeholder={t("plugins.appNamePlaceholder")}
            onChange={(event) => setInstallApp(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") install();
            }}
          />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInstallApp(null)}
              disabled={busyId !== null}
            >
              {t("plugins.cancel")}
            </Button>
            <Button onClick={install} disabled={busyId !== null || !(installApp ?? "").trim()}>
              {t("plugins.install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => !open && setPendingRemove(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("plugins.uninstallTitle")}</DialogTitle>
            <DialogDescription>
              {t("plugins.uninstallConfirm", { name: pendingRemove?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRemove(null)}>
              {t("plugins.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmRemove}>
              {t("plugins.uninstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PluginCard({
  plugin,
  up,
  streaming,
  busyId,
  onRun,
  onStop,
  onToggle,
  onConfigure,
  onUpdate,
  onOpenFolder,
  onOpenLog,
  onRemove,
}: {
  plugin: PluginView;
  /** The plugin's page answers, so it counts as running. */
  up: boolean;
  /** This plugin is the one whose output the panel is showing. */
  streaming: boolean;
  /**
   * The Scoop step in flight, by app id. Any step blocks every card's actions;
   * only this card's own step spins its update icon.
   */
  busyId: string | null;
  onRun: () => void;
  onStop: () => void;
  onToggle: () => void;
  onConfigure: () => void;
  onUpdate: () => void;
  onOpenFolder: () => void;
  onOpenLog: () => void;
  onRemove: () => void;
}) {
  const { t } = useAppTranslation();
  const broken = plugin.error !== null;
  // Either the page answers, or this window is watching one start. Neither is a
  // reason to touch any other card.
  const running = up || streaming;
  const busy = busyId !== null;
  const updating = busyId === plugin.id;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{plugin.name}</span>
            {plugin.version && (
              <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
                {plugin.version}
              </span>
            )}
          </div>
          {plugin.description && (
            <p className="text-muted-foreground mt-0.5 text-xs">{plugin.description}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onOpenLog} title={t("plugins.openLog")}>
            <FileText className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenFolder} title={t("plugins.openFolder")}>
            <FolderOpen className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={busy}
            title={t("plugins.uninstall")}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {broken ? (
        <p className="text-destructive mt-2 flex items-start gap-1.5 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {t("plugins.broken", { message: plugin.error ?? "" })}
        </p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant={plugin.enabled ? "default" : "outline"}
              size="sm"
              onClick={onToggle}
              disabled={running || busy}
            >
              {plugin.enabled ? t("plugins.enabled") : t("plugins.disabled")}
            </Button>

            {/* One button, two jobs: it runs the plugin, and pressing it again
                stops it. Driven by whether the address answers, so a plugin
                started on the Plugins page shows as running here too — and a
                server that runs for hours does not lock this card. */}
            {running ? (
              <Button variant="outline" size="sm" onClick={onStop} disabled={busy}>
                <Square className="size-4" />
                {t("plugins.stop")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={onRun}
                disabled={!plugin.enabled || busy}
              >
                <Play className="size-4" />
                {t("plugins.run")}
              </Button>
            )}

            <Button variant="outline" size="sm" onClick={onConfigure}>
              <SlidersHorizontal className="size-4" />
              {t("plugins.configure")}
            </Button>

            <Button variant="outline" size="sm" onClick={onUpdate} disabled={busy || running}>
              <RefreshCw className={cn("size-4", updating && "animate-spin")} />
              {t("plugins.update")}
            </Button>
          </div>

          {plugin.stopScript && (
            <p className="text-muted-foreground mt-1.5 text-xs">
              {t("plugins.stopScript", { script: plugin.stopScript })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
