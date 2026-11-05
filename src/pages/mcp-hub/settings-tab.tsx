import { useCallback, useEffect, useState } from "react";
import { Boxes, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  mcphubGetSettings,
  mcphubRegenerateCache,
  mcphubUpdateSettings,
  type McpHubMode,
  type SettingsView,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const MODE_OPTIONS: Array<{ value: McpHubMode; descKey: string }> = [
  { value: "discover", descKey: "mcphub.settings.modeDiscoverDesc" },
  { value: "passthrough", descKey: "mcphub.settings.modePassthroughDesc" },
];

export function SettingsTab() {
  const { t } = useAppTranslation();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [mode, setMode] = useState<McpHubMode>("discover");
  const [idleTimeout, setIdleTimeout] = useState<number>(300);

  const load = useCallback(async () => {
    try {
      const s = await mcphubGetSettings();
      setSettings(s);
      setMode(s.mode);
      setIdleTimeout(s.idleTimeout);
    } catch (error) {
      console.error("mcphub get settings:", error);
      toast.error(t("mcphub.settings.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const clamped = Math.min(3600, Math.max(30, Number(idleTimeout) || 300));
      await mcphubUpdateSettings({ mode, idleTimeout: clamped });
      toast.success(t("mcphub.settings.saved"));
      await load();
    } catch (error) {
      console.error("mcphub update settings:", error);
      toast.error(t("mcphub.settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      await mcphubRegenerateCache();
      toast.success(t("mcphub.regenerated"));
      await load();
    } catch (error) {
      console.error("mcphub regenerate:", error);
      toast.error(t("mcphub.regenerateFailed"));
    } finally {
      setRebuilding(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t("mcphub.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Mode */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("mcphub.settings.mode")}</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MODE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={cn(
                "cursor-pointer rounded-lg border p-3 transition-colors",
                mode === opt.value ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
              )}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="mcphub-mode"
                  checked={mode === opt.value}
                  onChange={() => setMode(opt.value)}
                />
                <span className="font-mono text-sm font-medium">{opt.value}</span>
              </div>
              <p className="text-muted-foreground mt-1.5 text-xs">{t(opt.descKey)}</p>
            </label>
          ))}
        </div>
      </div>

      {/* Idle timeout */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="mcphub-idle-timeout">
          {t("mcphub.settings.idleTimeout")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="mcphub-idle-timeout"
            type="number"
            min={30}
            max={3600}
            step={10}
            className="w-32"
            value={idleTimeout}
            onChange={(e) => setIdleTimeout(Number(e.target.value))}
          />
          <span className="text-muted-foreground text-xs">
            {t("mcphub.settings.idleTimeoutHint")}
          </span>
        </div>
      </div>

      {/* Cache status */}
      <div className="border-border flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <Boxes className="text-muted-foreground size-4" />
          <span className="text-sm">
            {settings && settings.cacheTools > 0
              ? t("mcphub.settings.cached", { count: settings.cacheTools })
              : t("mcphub.settings.noCache")}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleRebuild()}
          disabled={rebuilding}
        >
          <RefreshCw className={cn("size-4", rebuilding && "animate-spin")} />
          {t("mcphub.settings.rebuild")}
        </Button>
      </div>

      {/* Save */}
      <div className="flex justify-end">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("mcphub.settings.save")}
        </Button>
      </div>
    </div>
  );
}
