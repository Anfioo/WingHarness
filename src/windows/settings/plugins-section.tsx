import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Boxes,
  FileText,
  FolderOpen,
  Play,
  PlayCircle,
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
import { OutputPanel, type OutputLine, type RunStatus } from "@/components/output-panel";
import { Progress } from "@/components/ui/progress";
import { createWindow } from "@/lib/window";
import { encodeLabelId } from "@/lib/plugin-label";
import { usePluginsUp } from "@/hooks/use-plugins-up";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

export function PluginsSection() {
  const { t } = useAppTranslation();
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [dragging, setDragging] = useState(false);
  // The plugin whose output the panel is showing, if any. This is **not** a
  // lock: a plugin that serves a page streams for as long as it runs, so
  // treating it as "busy" would freeze every other card for hours.
  const [streaming, setStreaming] = useState<string | null>(null);
  // Which stream owns the panel. A run started later takes it over, and the
  // older run's late lines are dropped rather than interleaved.
  const streamSeq = useRef(0);
  const [pendingRemove, setPendingRemove] = useState<PluginView | null>(null);
  const [removing, setRemoving] = useState(false);
  // The install in flight, if any: the zip being unpacked and how far it has
  // got. `null` when nothing is installing.
  const [installing, setInstalling] = useState<InstallState | null>(null);

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

  const install = useCallback(
    async (paths: string[]) => {
      for (const [index, path] of paths.entries()) {
        setInstalling({
          name: fileName(path),
          index: index + 1,
          count: paths.length,
          written: 0,
          total: 0,
          // Timing is kept here, not in the backend: the event carries a
          // cumulative byte count, and rate is the change between two of them.
          startedAt: performance.now(),
        });

        try {
          const plugin = await pluginsInstall(path, (progress) => {
            setInstalling((current) =>
              current ? { ...current, written: progress.written, total: progress.total } : current
            );
          });
          toast.success(t("plugins.installed", { name: plugin.name }));
        } catch (error) {
          console.error("Failed to install plugin:", error);
          toast.error(t("plugins.installFailed", { name: fileName(path), message: String(error) }));
        }
      }

      setInstalling(null);
      await reload();
    },
    [reload, t]
  );

  // Drops arrive on the webview, not on a DOM element, so the listener is
  // registered once for the whole settings window.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          setDragging(event.payload.type !== "leave");
          return;
        }

        setDragging(false);
        const zips = event.payload.paths.filter((path) => path.toLowerCase().endsWith(".zip"));
        if (zips.length === 0) {
          toast.error(t("plugins.dropNotZip"));
          return;
        }
        void install(zips);
      })
      .then((stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch((error: unknown) => console.error("Failed to watch for dropped zips:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [install, t]);

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

  const confirmRemove = useCallback(async () => {
    if (!pendingRemove) return;

    setRemoving(true);
    try {
      await pluginsUninstall(pendingRemove.id);
      toast.success(t("plugins.uninstalled", { name: pendingRemove.name }));
      setPendingRemove(null);
      await reload();
    } catch (error) {
      console.error("Failed to uninstall plugin:", error);
      toast.error(String(error));
    } finally {
      setRemoving(false);
    }
  }, [pendingRemove, reload, t]);

  const installed = plugins ?? [];
  const enabledCount = installed.filter((plugin) => plugin.enabled).length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("plugins.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("plugins.description")}</p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={runEverything}
          disabled={streaming !== null || enabledCount === 0}
        >
          <PlayCircle className="size-4" />
          {t("plugins.runAll")}
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

      <div
        className={cn(
          "rounded-lg border border-dashed p-3 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
          streaming !== null && "opacity-60"
        )}
      >
        <p className="text-sm font-medium">
          {dragging ? t("plugins.dropTitle") : t("plugins.dropHint")}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">{t("plugins.dropNote")}</p>
      </div>

      {installing && <InstallProgressRow state={installing} />}

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
            onRun={() => runOne(plugin)}
            onStop={() => void stopOne(plugin)}
            onToggle={() => void toggleEnabled(plugin)}
            onConfigure={() => void openConfig(plugin)}
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
        running={streaming !== null}
        onClear={() => {
          setLines([]);
          setStatus({ kind: "idle" });
        }}
        placeholder={t("plugins.outputPlaceholder")}
      />

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
            <Button variant="outline" onClick={() => setPendingRemove(null)} disabled={removing}>
              {t("plugins.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()} disabled={removing}>
              {t("plugins.uninstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The install currently running: a bar, a percentage, the rate, and how many
 * zips are left.
 *
 * The rate is derived from the cumulative bytes the backend reports and a clock
 * read here, because the events are throttled and would otherwise read as
 * bursts. Ticking on an interval keeps the rate moving during a long copy even
 * when no event has arrived recently.
 */
function InstallProgressRow({ state }: { state: InstallState }) {
  const { t } = useAppTranslation();
  // Milliseconds since this zip started, kept in state so the clock is read in
  // the effect rather than during render. It drives the rate, which would
  // otherwise only move when a (throttled) progress event arrives.
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const read = () => setElapsedMs(performance.now() - state.startedAt);
    read();
    const timer = setInterval(read, 200);
    return () => clearInterval(timer);
    // Restart the clock when a new zip begins.
  }, [state.startedAt]);

  const { written, total } = state;
  const percent = total > 0 ? Math.min(100, (written / total) * 100) : 0;
  const seconds = elapsedMs / 1000;
  const rate = seconds > 0 ? written / seconds : 0;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium">{state.name}</span>
        {state.count > 1 && (
          <span className="text-muted-foreground">
            {t("plugins.installingCount", { index: state.index, count: state.count })}
          </span>
        )}
        <span className="text-muted-foreground ml-auto shrink-0">
          {t("plugins.installingRate", { rate: formatBytes(rate) })}
        </span>
      </div>

      <Progress value={percent} className="mt-2" />

      <div className="text-muted-foreground mt-1 flex items-center justify-between text-xs">
        <span>{t("plugins.installing")}</span>
        <span>
          {total > 0
            ? `${Math.round(percent)}% · ${formatBytes(written)} / ${formatBytes(total)}`
            : formatBytes(written)}
        </span>
      </div>
    </div>
  );
}

function PluginCard({
  plugin,
  up,
  streaming,
  onRun,
  onStop,
  onToggle,
  onConfigure,
  onOpenFolder,
  onOpenLog,
  onRemove,
}: {
  plugin: PluginView;
  /** The plugin's page answers, so it counts as running. */
  up: boolean;
  /** This plugin is the one whose output the panel is showing. */
  streaming: boolean;
  onRun: () => void;
  onStop: () => void;
  onToggle: () => void;
  onConfigure: () => void;
  onOpenFolder: () => void;
  onOpenLog: () => void;
  onRemove: () => void;
}) {
  const { t } = useAppTranslation();
  const broken = plugin.error !== null;
  // Either the page answers, or this window is watching one start. Neither is a
  // reason to touch any other card.
  const running = up || streaming;

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
          <Button variant="ghost" size="sm" onClick={onRemove} title={t("plugins.uninstall")}>
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
              disabled={running}
            >
              {plugin.enabled ? t("plugins.enabled") : t("plugins.disabled")}
            </Button>

            {/* One button, two jobs: it runs the plugin, and pressing it again
                stops it. Driven by the backend's running set, so a plugin
                started from the 插件 page shows as running here too — and a
                server that runs for hours does not lock this card. */}
            {running ? (
              <Button variant="outline" size="sm" onClick={onStop}>
                <Square className="size-4" />
                {t("plugins.stop")}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onRun} disabled={!plugin.enabled}>
                <Play className="size-4" />
                {t("plugins.run")}
              </Button>
            )}

            <Button variant="outline" size="sm" onClick={onConfigure}>
              <SlidersHorizontal className="size-4" />
              {t("plugins.configure")}
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

/** Last path segment, used to name a zip in an error message. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The install currently running, as the progress row renders it. */
type InstallState = {
  /** File name of the zip being unpacked. */
  name: string;
  /** 1-based index of this zip among the dropped ones. */
  index: number;
  /** How many zips were dropped together. */
  count: number;
  /** Unpacked bytes written so far. */
  written: number;
  /** Total unpacked bytes; 0 until the first event settles it. */
  total: number;
  /** `performance.now()` when this zip started, for the rate. */
  startedAt: number;
};

/** Human-readable size, e.g. `12.3 MB`. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
