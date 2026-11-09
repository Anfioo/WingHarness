import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { Plus, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_PINNED_PORTS,
  MAX_PINNED_PORTS,
  portsErrorCode,
  portsSettingsGet,
  portsSettingsSet,
  type PortsSettings,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { portsErrorKey } from "@/lib/ports/error-key";
import { PORTS_SETTINGS_CHANGED } from "@/lib/ports/settings-event";
import { cn } from "@/lib/utils";

const MAX_PORT = 65_535;

/**
 * The ports partition of the Settings window.
 *
 * Everything saves at once: adding, removing or resetting a pin and toggling
 * the pinned-only view are discrete actions, so there is no draft to lose. The
 * ports page listens for the change event and applies it without a reload.
 */
export function PortsSection() {
  const { t } = useAppTranslation();

  const [settings, setSettings] = useState<PortsSettings | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    portsSettingsGet()
      .then(setSettings)
      .catch((error: unknown) => {
        console.error("Failed to load the ports settings:", error);
        setFailed(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(() => {
    portsSettingsGet()
      .then(setSettings)
      .catch((error: unknown) => console.error("Failed to load the ports settings:", error));
  }, []);

  // The ports page's own pin buttons write the same document.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listen(PORTS_SETTINGS_CHANGED, reload).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [reload]);

  const persist = useCallback(
    async (next: PortsSettings) => {
      try {
        setSettings(await portsSettingsSet(next));
        await emit(PORTS_SETTINGS_CHANGED);
      } catch (failure) {
        console.error("Failed to save the ports settings:", failure);
        toast.error(t(portsErrorKey(portsErrorCode(failure))));
        reload();
      }
    },
    [reload, t]
  );

  const full = settings !== null && settings.pinnedPorts.length >= MAX_PINNED_PORTS;

  const addPort = () => {
    if (!settings) return;
    const trimmed = input.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!/^\d+$/.test(trimmed) || parsed < 1 || parsed > MAX_PORT) {
      toast.error(t("ports.settings.invalid"));
      return;
    }
    if (settings.pinnedPorts.includes(parsed)) {
      toast.error(t("ports.settings.duplicate"));
      return;
    }
    if (full) {
      toast.error(t("ports.settings.full"));
      return;
    }
    setInput("");
    void persist({
      ...settings,
      pinnedPorts: [...settings.pinnedPorts, parsed].sort((left, right) => left - right),
    });
  };

  const removePort = (port: number) => {
    if (!settings) return;
    void persist({
      ...settings,
      pinnedPorts: settings.pinnedPorts.filter((value) => value !== port),
    });
  };

  const resetPorts = () => {
    if (!settings) return;
    void persist({ ...settings, pinnedPorts: [...DEFAULT_PINNED_PORTS] });
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold">{t("ports.settings.title")}</h2>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (failed || !settings) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t("ports.settings.title")}</h2>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">{t("ports.settings.loadFailed")}</span>
          <Button size="sm" variant="outline" onClick={load}>
            {t("ports.settings.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("ports.settings.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("ports.settings.description")}</p>
      </div>

      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold">{t("ports.settings.pinned")}</h3>
            <p className="text-muted-foreground text-xs">{t("ports.settings.pinnedHint")}</p>
          </div>
          <Button variant="ghost" size="xs" onClick={resetPorts}>
            <RotateCcw />
            {t("ports.settings.reset")}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Input
            inputMode="numeric"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addPort();
            }}
            placeholder={t("ports.settings.addPlaceholder")}
            aria-label={t("ports.settings.addPlaceholder")}
            className="max-w-48 font-mono"
          />
          <Button variant="outline" disabled={input.trim().length === 0} onClick={addPort}>
            <Plus />
            {t("ports.settings.add")}
          </Button>
        </div>

        <div className="border-border max-h-56 overflow-y-auto rounded-lg border p-2">
          {settings.pinnedPorts.length === 0 ? (
            <p className="text-muted-foreground px-1 py-2 text-xs">{t("ports.settings.empty")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {settings.pinnedPorts.map((port) => (
                <span
                  key={port}
                  className="bg-muted inline-flex h-7 items-center gap-1 rounded-md pr-1 pl-2 font-mono text-xs"
                >
                  {port}
                  <button
                    type="button"
                    onClick={() => removePort(port)}
                    aria-label={t("ports.row.unpinAria", { port })}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex size-5 items-center justify-center rounded transition-colors"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                full ? "bg-destructive" : "bg-foreground/40"
              )}
              style={{ width: `${(settings.pinnedPorts.length / MAX_PINNED_PORTS) * 100}%` }}
            />
          </div>
          <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
            {t("ports.settings.count", {
              count: settings.pinnedPorts.length,
              max: MAX_PINNED_PORTS,
            })}
          </span>
        </div>
      </section>

      <section className="border-border flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-0.5">
          <h3 id="ports-pinned-only-label" className="text-sm font-medium">
            {t("ports.settings.pinnedOnly")}
          </h3>
          <p className="text-muted-foreground text-xs">{t("ports.settings.pinnedOnlyHint")}</p>
        </div>
        <Switch
          checked={settings.pinnedOnly}
          onCheckedChange={(checked) => void persist({ ...settings, pinnedOnly: checked })}
          aria-labelledby="ports-pinned-only-label"
        />
      </section>
    </div>
  );
}
