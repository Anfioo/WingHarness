import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  agentStatus,
  getPreviewPreferences,
  setAgentEnabled,
  type AgentStatus,
  type FilePreviewConfig,
  type PreviewPreferences,
  type TextEncoding,
} from "@/commands";
import { TEXT_ENCODINGS } from "@/components/code-editor";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useConfigDraft } from "@/hooks/use-config-draft";
import { useSpacePreviewPreferences } from "@/hooks/use-space-preview-preferences";

/** The range the backend clamps to, mirrored here so the field cannot lie. */
const MB = 1024 * 1024;
const MAX_SIZE = { min: 1, max: 1024 };

/** A value past the allowed range is pulled to the nearest bound, not dropped. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A number input that lets the field be empty while typing and commits on blur
 * or Enter, so a half-typed value is never written to the config.
 */
function NumberField({
  value,
  min,
  max,
  unit,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  // Follow the stored value when it changes from outside (first load, retry).
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const next = clamp(parsed, min, max);
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="w-24"
        value={text}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {unit ? <span className="text-muted-foreground text-xs">{unit}</span> : null}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * How the preview page reads and paints files.
 *
 * Two stores are edited here. The threshold and the highlight switch live in
 * `config.json` and are enforced by the old byte reader; the space switch, the
 * reading width, the font size and the default encoding live in `preview.json`
 * and are shared with the preview host and the tray. The space switch goes
 * through the agent command so the hook is retuned immediately instead of on the
 * next restart.
 */
export function FilePreviewSection() {
  const { t } = useAppTranslation();
  const { draft, setDraft, loading } = useConfigDraft("file preview");
  const { preferences, loading: preferencesLoading, save } = useSpacePreviewPreferences();
  const [agent, setAgent] = useState<AgentStatus | null>(null);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;

    void agentStatus()
      .then((next) => {
        if (alive) setAgent(next);
      })
      .catch(() => {});

    // The tray can switch the handler while this window is open.
    void listen<{ enabled: boolean; running: boolean }>("sp:agent-status", (event) => {
      if (!alive) return;
      setAgent((current) => ({
        enabled: event.payload.enabled,
        running: event.payload.running,
        comReady: current?.comReady ?? false,
      }));
    }).then((unlisten) => {
      if (alive) stop = unlisten;
      else unlisten();
    });

    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  const update = (patch: Partial<FilePreviewConfig>) => {
    setDraft((current) =>
      current ? { ...current, filePreview: { ...current.filePreview, ...patch } } : current
    );
  };

  const updatePreferences = async (patch: Partial<PreviewPreferences>) => {
    try {
      // Re-read first: the tray writes the same file, and this window's copy may
      // predate its space switch.
      const latest = await getPreviewPreferences();
      await save({ ...latest, ...patch });
    } catch (error) {
      toast.error(
        t("spacePreview.settings.saveFailed", {
          defaultValue: "Could not save the preview preferences.",
        }),
        { description: error instanceof Error ? error.message : String(error) }
      );
    }
  };

  const toggleSpace = async (enabled: boolean) => {
    try {
      setAgent(await setAgentEnabled(enabled));
    } catch (error) {
      toast.error(
        t("spacePreview.settings.spaceFailed", {
          defaultValue: "The space preview handler could not be changed.",
        }),
        { description: error instanceof Error ? error.message : String(error) }
      );
    }
  };

  const agentLabel = agent
    ? agent.enabled
      ? agent.running
        ? t("spacePreview.settings.running", { defaultValue: "Running" })
        : t("spacePreview.settings.enabledNotRunning", {
            defaultValue: "Enabled, not running",
          })
      : t("spacePreview.settings.disabled", { defaultValue: "Off" })
    : null;

  const config = draft?.filePreview;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.filePreview.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.filePreview.description")}</p>
      </div>

      {loading && !config ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : config ? (
        <div className="border-border divide-y rounded-xl border px-4">
          <Row
            label={t("settings.filePreview.maxSize")}
            hint={t("settings.filePreview.maxSizeHint")}
          >
            <NumberField
              value={Math.round(config.maxBytes / MB)}
              min={MAX_SIZE.min}
              max={MAX_SIZE.max}
              unit={t("settings.filePreview.maxSizeUnit")}
              onChange={(mb) => update({ maxBytes: mb * MB })}
            />
          </Row>
          <Row
            label={t("settings.filePreview.highlight")}
            hint={t("settings.filePreview.highlightHint")}
          >
            <Switch
              checked={config.highlight}
              onCheckedChange={(highlight) => update({ highlight })}
            />
          </Row>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("settings.filePreview.loadFailed")}</p>
      )}

      <p className="text-muted-foreground text-xs">{t("settings.filePreview.autoSave")}</p>

      <div>
        <h3 className="mb-1 text-sm font-semibold">
          {t("spacePreview.settings.behavior", { defaultValue: "Preview behavior" })}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("spacePreview.settings.behaviorHint", {
            defaultValue:
              "The space key, the reading width, the font size and the encoding apply to every preview window.",
          })}
        </p>
      </div>

      {preferencesLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <div className="border-border divide-y rounded-xl border px-4">
          <Row
            label={t("spacePreview.settings.spaceEnabled")}
            hint={t("spacePreview.settings.spaceEnabledHint")}
          >
            <div className="flex items-center gap-2">
              {agentLabel ? (
                <span className="text-muted-foreground text-xs">{agentLabel}</span>
              ) : null}
              <Switch
                checked={preferences.spaceEnabled}
                onCheckedChange={(enabled) => void toggleSpace(enabled)}
              />
            </div>
          </Row>
          <Row label={t("spacePreview.settings.readingWidth")}>
            <NumberField
              value={preferences.readingWidth}
              min={320}
              max={2000}
              unit="px"
              onChange={(readingWidth) => void updatePreferences({ readingWidth })}
            />
          </Row>
          <Row label={t("spacePreview.settings.fontSize")}>
            <NumberField
              value={preferences.fontSize}
              min={8}
              max={32}
              unit="px"
              onChange={(fontSize) => void updatePreferences({ fontSize })}
            />
          </Row>
          <Row label={t("spacePreview.settings.defaultEncoding")}>
            <Select
              value={preferences.defaultEncoding}
              onValueChange={(value) =>
                void updatePreferences({ defaultEncoding: value as TextEncoding })
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEXT_ENCODINGS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.key, { defaultValue: item.fallback })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {t("spacePreview.settings.autoSave", { defaultValue: "Changes save automatically." })}
      </p>
    </div>
  );
}
