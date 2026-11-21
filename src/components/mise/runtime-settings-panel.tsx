// The runtime settings panel: the five `[settings]` values the engine exposes,
// each with its default, and a dialog that collects them before the shared diff
// stage. Values are only strings here; the engine owns TOML generation.

import { useState } from "react";
import { AlertTriangle, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import {
  miseErrorCode,
  type MiseConfigEdit,
  type MiseConfigRuntimeSetting,
  type MiseConfigRuntimeSettings,
  type MiseConfigSavePreview,
  type MiseConfigSaveResult,
  type MiseErrorCode,
} from "@/commands";
import { ConfigDiffDialog } from "@/components/mise/config-diff-dialog";
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
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { camelCaseKey } from "@/hooks/use-mise-config";
import { miseErrorKey } from "@/lib/mise/error-key";
import { cn } from "@/lib/utils";

export type RuntimeSettingsPanelProps = {
  settings: MiseConfigRuntimeSettings;
  onPreview: (edit: MiseConfigEdit) => Promise<MiseConfigSavePreview>;
  onSave: (path: string, nextContent: string) => Promise<MiseConfigSaveResult>;
};

/**
 * A boolean that is not set has no value to show, so the switch starts at its
 * default; `buildEdit` then omits it unless the switch was moved, which keeps an
 * untouched default from being written as an explicit line.
 */
function initialDraft(settings: MiseConfigRuntimeSetting[]): Record<string, string> {
  return Object.fromEntries(
    settings.map((setting) => [
      setting.key,
      setting.valueType === "boolean"
        ? (setting.isSet ? setting.value : setting.defaultValue) === "true"
          ? "true"
          : "false"
        : setting.value,
    ])
  );
}

function displayValue(setting: MiseConfigRuntimeSetting): string {
  if (!setting.isSet) return "";
  if (setting.valueType === "boolean") return setting.value === "true" ? "on" : "off";
  return setting.value;
}

export function RuntimeSettingsPanel({ settings, onPreview, onSave }: RuntimeSettingsPanelProps) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<MiseConfigSavePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<MiseErrorCode | null>(null);

  const openEditor = () => {
    setDraft(initialDraft(settings.settings));
    setPreview(null);
    setError(null);
    setOpen(true);
  };

  const buildEdit = (): MiseConfigEdit => {
    const values: Record<string, string | null> = {};
    const initial = initialDraft(settings.settings);
    for (const setting of settings.settings) {
      const raw = (draft[setting.key] ?? "").trim();
      if (setting.valueType === "boolean") {
        // An untouched switch (including an unset setting showing its default)
        // must not add a line to the file.
        if (raw === initial[setting.key]) continue;
        values[setting.key] = raw === "true" ? "true" : "false";
      } else {
        values[setting.key] = raw === "" ? null : raw;
      }
    }
    return { kind: "settings", values };
  };

  const generatePreview = async () => {
    if (previewBusy) return;

    setPreviewBusy(true);
    setError(null);
    try {
      const next = await onPreview(buildEdit());
      if (!next.hasChanges) {
        toast.info(t("mise.config.diff.noChanges"));
        return;
      }
      setPreview(next);
    } catch (failure) {
      setError(miseErrorCode(failure) ?? "internal");
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <section className="border-border bg-card rounded-xl border">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{t("mise.config.runtime.title")}</h2>
          <p className="text-muted-foreground text-xs">{t("mise.config.runtime.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={openEditor}>
          <Pencil />
          {t("mise.config.runtime.edit")}
        </Button>
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {settings.settings.map((setting) => {
          const value = displayValue(setting);
          return (
            <div key={setting.key} className="border-border bg-muted/30 rounded-lg border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {t(`mise.config.runtime.${camelCaseKey(setting.key)}`)}
                </span>
                <span className="text-muted-foreground font-mono text-[11px]">{setting.key}</span>
              </div>
              <p
                className={cn(
                  "mt-1 text-sm font-medium break-all",
                  setting.isSet ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {value === ""
                  ? t("mise.common.notSet")
                  : setting.valueType === "boolean"
                    ? t(value === "on" ? "mise.common.on" : "mise.common.off")
                    : value}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("mise.config.runtime.default")}: {setting.defaultValue}
              </p>
            </div>
          );
        })}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (previewBusy) return;
          setOpen(next);
          if (!next) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("mise.config.runtime.edit")}</DialogTitle>
            <DialogDescription className="font-mono text-xs break-all select-text">
              {settings.path}
            </DialogDescription>
          </DialogHeader>

          {error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 break-words">{t(miseErrorKey(error))}</span>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {settings.settings.map((setting) => {
              const inputId = `mise-runtime-${setting.key}`;
              const checked = draft[setting.key] === "true";
              return (
                <div key={setting.key} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor={inputId} className="text-sm font-medium">
                      {t(`mise.config.runtime.${camelCaseKey(setting.key)}`)}
                    </label>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {setting.key}
                    </span>
                  </div>

                  {setting.valueType === "boolean" ? (
                    <div className="flex items-center gap-2">
                      <Switch
                        id={inputId}
                        checked={checked}
                        onCheckedChange={(next) =>
                          setDraft((current) => ({
                            ...current,
                            [setting.key]: next ? "true" : "false",
                          }))
                        }
                      />
                      <span className="text-muted-foreground text-xs">
                        {t(checked ? "mise.common.on" : "mise.common.off")}
                      </span>
                    </div>
                  ) : (
                    <Input
                      id={inputId}
                      type={setting.valueType === "integer" ? "number" : "text"}
                      value={draft[setting.key] ?? ""}
                      placeholder={setting.defaultValue}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [setting.key]: event.target.value,
                        }))
                      }
                    />
                  )}

                  <span className="text-muted-foreground text-xs">
                    {t("mise.config.runtime.default")}: {setting.defaultValue}
                  </span>
                </div>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={previewBusy}
              onClick={() => {
                setOpen(false);
                setPreview(null);
              }}
            >
              {t("mise.actions.cancel")}
            </Button>
            <Button disabled={previewBusy} onClick={() => void generatePreview()}>
              {previewBusy && <Loader2 className="animate-spin" />}
              {previewBusy ? t("mise.common.loading") : t("mise.actions.preview")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {preview && (
        <ConfigDiffDialog
          open
          preview={preview}
          onSave={() => onSave(preview.path, preview.nextContent)}
          onSaved={() => setOpen(false)}
          onBack={() => setPreview(null)}
          onOpenChange={(next) => {
            if (!next) setPreview(null);
          }}
        />
      )}
    </section>
  );
}
