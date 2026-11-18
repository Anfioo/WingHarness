// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  getConfig,
  type BodyDisplayMode,
  type OneMailSettings,
  type RemoteImagesPolicy,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useOneMailSettings } from "@/hooks/use-one-mail-settings";
import { cn } from "@/lib/utils";

const REFRESH_MIN = 1;
const REFRESH_MAX = 1440;
const WINDOW_MIN = 1;
const WINDOW_MAX = 3650;

/**
 * The mail partition of the Settings window.
 *
 * Every control commits the moment it changes; the hook keeps the last
 * document the backend accepted, so a rejected save leaves the old value on
 * screen. The two number fields keep a draft between keystrokes and roll
 * themselves back when the save fails.
 */
export function OneMailSection() {
  const { t } = useAppTranslation();
  const { settings, loading, saving, error, reload, save } = useOneMailSettings();
  const [refreshDraft, setRefreshDraft] = useState("");
  const [windowDraft, setWindowDraft] = useState("");
  const [refreshInvalid, setRefreshInvalid] = useState(false);
  const [windowInvalid, setWindowInvalid] = useState(false);
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setRefreshDraft(String(settings.refreshIntervalMinutes));
    setWindowDraft(String(settings.syncWindowDays));
    setRefreshInvalid(false);
    setWindowInvalid(false);
  }, [settings]);

  // The hint names the concrete folder on this machine; the path is composed
  // from the data directory the backend resolved, not from a hardcoded root.
  useEffect(() => {
    void getConfig()
      .then((view) => {
        const separator = view.dataDir.includes("\\") ? "\\" : "/";
        setDataDir(`${view.dataDir}${separator}one-mail`);
      })
      .catch(() => setDataDir(null));
  }, []);

  const commit = async (patch: Partial<OneMailSettings>): Promise<boolean> => {
    if (!settings) return false;
    const saved = await save({ ...settings, ...patch });
    if (!saved) toast.error(t("oneMail.settings.saveFailed"));
    return saved !== null;
  };

  const commitNumber = async (
    raw: string,
    min: number,
    max: number,
    field: "refreshIntervalMinutes" | "syncWindowDays"
  ): Promise<boolean> => {
    const parsed = Number(raw.trim());
    // A half-typed or out-of-range draft stays on screen with an inline error
    // and is not sent; only a rejected save rolls the field back.
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return false;
    if (settings && parsed === settings[field]) return true;
    return await commit({ [field]: parsed });
  };

  const onRefreshBlur = async () => {
    const parsed = Number(refreshDraft.trim());
    if (!Number.isInteger(parsed) || parsed < REFRESH_MIN || parsed > REFRESH_MAX) {
      setRefreshInvalid(true);
      return;
    }
    setRefreshInvalid(false);
    const ok = await commitNumber(refreshDraft, REFRESH_MIN, REFRESH_MAX, "refreshIntervalMinutes");
    if (!ok) setRefreshDraft(String(settings?.refreshIntervalMinutes ?? REFRESH_MIN));
  };

  const onWindowBlur = async () => {
    const parsed = Number(windowDraft.trim());
    if (!Number.isInteger(parsed) || parsed < WINDOW_MIN || parsed > WINDOW_MAX) {
      setWindowInvalid(true);
      return;
    }
    setWindowInvalid(false);
    const ok = await commitNumber(windowDraft, WINDOW_MIN, WINDOW_MAX, "syncWindowDays");
    if (!ok) setWindowDraft(String(settings?.syncWindowDays ?? WINDOW_MIN));
  };

  const disabled = saving || loading;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("oneMail.settings.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("oneMail.settings.subtitle")}</p>
      </div>

      {loading && !settings ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("oneMail.common.loading")}
        </p>
      ) : !settings ? (
        <div className="space-y-2">
          <p role="alert" className="text-destructive text-sm">
            {error ?? t("oneMail.errors.internal")}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
            <RefreshCw />
            {t("oneMail.common.retry")}
          </Button>
        </div>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}

          <Section>
            <NumberRow
              id="one-mail-settings-refresh"
              label={t("oneMail.settings.refreshInterval")}
              hint={t("oneMail.settings.refreshIntervalHint")}
              value={refreshDraft}
              min={REFRESH_MIN}
              max={REFRESH_MAX}
              disabled={disabled}
              error={refreshInvalid ? t("oneMail.errors.invalidInput") : undefined}
              onChange={setRefreshDraft}
              onBlur={() => void onRefreshBlur()}
            />

            <FieldRow
              label={t("oneMail.settings.bodyDisplay")}
              hint={t("oneMail.settings.bodyDisplayDescription")}
              htmlFor="one-mail-settings-body"
            >
              <Select
                value={settings.bodyDisplayMode}
                disabled={disabled}
                onValueChange={(value) =>
                  void commit({ bodyDisplayMode: value as BodyDisplayMode })
                }
              >
                <SelectTrigger id="one-mail-settings-body" className="w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="html">{t("oneMail.settings.bodyDisplayHtml")}</SelectItem>
                  <SelectItem value="text">{t("oneMail.settings.bodyDisplayText")}</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>

            <FieldRow label={t("oneMail.settings.remoteImages")} htmlFor="one-mail-settings-images">
              <Select
                value={settings.remoteImagesPolicy}
                disabled={disabled}
                onValueChange={(value) =>
                  void commit({ remoteImagesPolicy: value as RemoteImagesPolicy })
                }
              >
                <SelectTrigger id="one-mail-settings-images" className="w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">{t("oneMail.settings.remoteImagesBlock")}</SelectItem>
                  <SelectItem value="load">{t("oneMail.settings.remoteImagesLoad")}</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>

            <NumberRow
              id="one-mail-settings-window"
              label={t("oneMail.settings.syncWindowDays")}
              value={windowDraft}
              min={WINDOW_MIN}
              max={WINDOW_MAX}
              disabled={disabled}
              error={windowInvalid ? t("oneMail.errors.invalidInput") : undefined}
              onChange={setWindowDraft}
              onBlur={() => void onWindowBlur()}
            />

            <FieldRow
              label={t("oneMail.settings.notifyOnNewMail")}
              htmlFor="one-mail-settings-notify"
            >
              <Switch
                id="one-mail-settings-notify"
                checked={settings.notifyOnNewMail}
                disabled={disabled}
                aria-label={t("oneMail.settings.notifyOnNewMail")}
                onCheckedChange={(checked) => void commit({ notifyOnNewMail: checked })}
              />
            </FieldRow>
          </Section>

          <section className="space-y-1.5 rounded-lg border px-3 py-2.5">
            <p className="text-sm">{t("oneMail.settings.dataDirHint", { path: dataDir ?? "…" })}</p>
            <p className="text-destructive text-xs">{t("oneMail.settings.dataDirWarning")}</p>
          </section>
        </>
      )}
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="divide-y">{children}</div>;
}

function FieldRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      <div className="min-w-0 sm:justify-self-end">{children}</div>
    </div>
  );
}

function NumberRow({
  id,
  label,
  hint,
  value,
  min,
  max,
  disabled,
  error,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  min: number;
  max: number;
  disabled: boolean;
  error?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <FieldRow label={label} htmlFor={id} hint={hint}>
      <div className="space-y-1">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          className={cn("w-full sm:w-32", error && "border-destructive")}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>
    </FieldRow>
  );
}
