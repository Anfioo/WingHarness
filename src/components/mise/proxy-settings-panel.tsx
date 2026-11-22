// The proxy panel: the four `[env]` proxy variables, shown with their current
// values, and a dialog that writes them through the shared diff stage. Empty
// inputs become `null`, which removes the line; the engine also writes the
// upper/lower-case aliases.

import { useState } from "react";
import { AlertTriangle, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import {
  miseErrorCode,
  type MiseConfigEdit,
  type MiseConfigProxySetting,
  type MiseConfigProxySettings,
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
import { useAppTranslation } from "@/hooks/use-app-translation";
import { camelCaseKey } from "@/hooks/use-mise-config";
import { miseErrorKey } from "@/lib/mise/error-key";
import { cn } from "@/lib/utils";

export type ProxySettingsPanelProps = {
  settings: MiseConfigProxySettings;
  onPreview: (edit: MiseConfigEdit) => Promise<MiseConfigSavePreview>;
  onSave: (path: string, nextContent: string) => Promise<MiseConfigSaveResult>;
};

const URI_PATTERN = /^(https?|socks5):\/\//i;

function initialDraft(settings: MiseConfigProxySetting[]): Record<string, string> {
  return Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
}

function needsUriHint(setting: MiseConfigProxySetting, value: string): boolean {
  const trimmed = value.trim();
  return setting.requiresUri && trimmed !== "" && !URI_PATTERN.test(trimmed);
}

export function ProxySettingsPanel({ settings, onPreview, onSave }: ProxySettingsPanelProps) {
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
    for (const setting of settings.settings) {
      const raw = (draft[setting.key] ?? "").trim();
      values[setting.key] = raw === "" ? null : raw;
    }
    return { kind: "proxy", values };
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
          <h2 className="text-sm font-medium">{t("mise.config.proxy.title")}</h2>
          <p className="text-muted-foreground text-xs">{t("mise.config.proxy.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={openEditor}>
          <Pencil />
          {t("mise.config.proxy.edit")}
        </Button>
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {settings.settings.map((setting) => (
          <div key={setting.key} className="border-border bg-muted/30 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">
                {t(`mise.config.proxy.${camelCaseKey(setting.key)}`)}
              </span>
              <span className="text-muted-foreground font-mono text-[11px]">{setting.key}</span>
            </div>
            <p
              className={cn(
                "mt-1 text-sm font-medium break-all",
                setting.isSet ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {setting.isSet && setting.value.trim() !== ""
                ? setting.value
                : t("mise.common.notSet")}
            </p>
          </div>
        ))}
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
            <DialogTitle>{t("mise.config.proxy.edit")}</DialogTitle>
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
              const inputId = `mise-proxy-${setting.key}`;
              const value = draft[setting.key] ?? "";
              const hint = needsUriHint(setting, value);
              return (
                <div key={setting.key} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor={inputId} className="text-sm font-medium">
                      {t(`mise.config.proxy.${camelCaseKey(setting.key)}`)}
                    </label>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {setting.key}
                    </span>
                  </div>
                  <Input
                    id={inputId}
                    value={value}
                    placeholder={setting.placeholder}
                    aria-invalid={hint}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [setting.key]: event.target.value,
                      }))
                    }
                  />
                  {hint && (
                    <span className="text-destructive text-xs">
                      {t("mise.config.proxy.requiresUri")}
                    </span>
                  )}
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
