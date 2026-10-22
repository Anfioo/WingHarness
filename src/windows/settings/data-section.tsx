import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { ArrowRight, Database, FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { getConfig, setDataDir, type ConfigView } from "@/commands";

/**
 * Where the app keeps everything it persists — plugins, logs, caches, and the
 * config file — and the pointer file that can move that directory elsewhere.
 *
 * Unlike the other settings sections this one does not go through
 * `useConfigDraft`: the target is a single pointer file, not the `Config`
 * document, and it only takes effect after a restart. So it loads and saves on
 * its own, and shows a restart prompt while the running directory is behind.
 */
export function DataSection() {
  const { t } = useAppTranslation();

  const [view, setView] = useState<ConfigView | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const applyView = useCallback((next: ConfigView) => {
    setView(next);
    setInput(next.dataDirConfigured ?? next.dataDir);
  }, []);

  useEffect(() => {
    let alive = true;
    getConfig()
      .then((next) => {
        if (alive) applyView(next);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the data directory settings:", error);
        toast.error(t("data.loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [applyView, t]);

  const save = async (target: string | null) => {
    setBusy(true);
    try {
      applyView(await setDataDir(target));
      toast.success(t("data.saved"));
    } catch (error: unknown) {
      console.error("Failed to set the data directory:", error);
      toast.error(t("data.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const chosen = await open({ directory: true, defaultPath: input || view?.dataDir });
    if (typeof chosen === "string") setInput(chosen);
  };

  if (!view) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="mb-1 text-lg font-semibold">{t("data.title")}</h2>
          <p className="text-muted-foreground text-sm">{t("data.description")}</p>
        </div>
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  // What a restart would use: the configured directory, or the default when the
  // pointer is cleared. Comparing it against the running one covers both moving
  // to a new directory and clearing back to the default.
  const target = view.dataDirConfigured ?? view.dataDirDefault;
  const pending = target !== view.dataDir;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("data.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("data.description")}</p>
      </div>

      {pending && (
        <div className="border-primary/40 bg-primary/5 flex items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("data.pendingTitle")}</p>
            <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs" title={target}>
              {target}
            </p>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => void relaunch()}>
            <RotateCcw className="size-4" />
            {t("data.restartNow")}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="data-dir" className="text-sm font-medium">
          {t("data.dirLabel")}
        </label>
        <p className="text-muted-foreground text-xs">{t("data.dirHint")}</p>
        <div className="flex items-center gap-2">
          <Input
            id="data-dir"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={view.dataDirDefault}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => void pick()}>
            <FolderOpen className="size-4" />
            {t("data.pick")}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void save(input.trim() || null)}>
            {t("data.save")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || view.dataDirConfigured === null}
            onClick={() => void save(null)}
          >
            {t("data.clear")}
          </Button>
        </div>
      </div>

      <div className="border-border space-y-2 border-t pt-4 text-xs">
        <Row label={t("data.currentLabel")} value={view.dataDir} muted={false} />
        <div className="text-muted-foreground flex items-center gap-1.5">
          <Database className="size-3.5 shrink-0" />
          <span>{t("data.currentHint")}</span>
        </div>
        <Row label={t("data.defaultLabel")} value={view.dataDirDefault} muted />
        <Row label={t("data.pointerLabel")} value={view.dataDirPointer} muted />
        <p className="text-muted-foreground">{t("data.pointerNote")}</p>
      </div>
    </div>
  );
}

/** One read-only "label: path" line, with the full value in the tooltip. */
function Row({ label, value, muted }: { label: string; value: string; muted: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-24 shrink-0">{label}</span>
      <ArrowRight className="text-muted-foreground mt-0.5 size-3 shrink-0" />
      <span className={cn("font-mono break-all", muted && "text-muted-foreground")} title={value}>
        {value}
      </span>
    </div>
  );
}
