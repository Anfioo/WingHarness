import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  agentStatus,
  getPreviewPreferences,
  setAgentEnabled,
  type AgentStatus,
  type PreviewFont,
  type PreviewHtmlView,
  type PreviewKey,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useSpacePreviewPreferences } from "@/hooks/use-space-preview-preferences";
import {
  archiveSizeOptions,
  previewFonts,
  previewHtmlViews,
  previewSizeOptions,
} from "@/lib/space-preview/preferences";
import { cn } from "@/lib/utils";

type SettingsTab = "preview" | "resources" | "multi" | "shortcuts" | "guide";

const TABS: { id: SettingsTab; key: string; fallback: string }[] = [
  { id: "preview", key: "spacePreview.settings.tabPreview", fallback: "Preview" },
  { id: "resources", key: "spacePreview.settings.tabResources", fallback: "Resources" },
  { id: "multi", key: "spacePreview.settings.tabMulti", fallback: "Multiple files" },
  { id: "shortcuts", key: "spacePreview.settings.tabShortcuts", fallback: "Shortcuts" },
  { id: "guide", key: "spacePreview.settings.tabGuide", fallback: "Guide" },
];

const FONT_LABELS: Record<PreviewFont, { key: string; fallback: string }> = {
  auto: { key: "spacePreview.settings.fontAuto", fallback: "Automatic" },
  sans: { key: "spacePreview.settings.fontSans", fallback: "Sans serif" },
  serif: { key: "spacePreview.settings.fontSerif", fallback: "Serif" },
  mono: { key: "spacePreview.settings.fontMono", fallback: "Monospace" },
};

const HTML_LABELS: Record<PreviewHtmlView, { key: string; fallback: string }> = {
  source: { key: "spacePreview.settings.htmlSource", fallback: "Source code" },
  web: { key: "spacePreview.settings.htmlWeb", fallback: "Web preview" },
};

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
  help,
  children,
}: {
  label: string;
  hint?: string;
  /** Explained behind a question mark after the label. */
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {help ? (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={help}
                    className="border-border text-muted-foreground hover:text-foreground inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none"
                  >
                    ?
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-64">
                  {help}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
        {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Choice({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="bg-background text-foreground w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[11px] font-medium">
      {children}
    </kbd>
  );
}

/**
 * How the preview opens and paints files.
 *
 * The space switch, every viewer preference and the resource caps live in
 * `preview.json` and are shared with the preview host and the tray. The space
 * switch goes through the agent command so the hook is retuned immediately
 * instead of on the next restart.
 */
export function FilePreviewSection() {
  const { t } = useAppTranslation();
  const { preferences, loading: preferencesLoading, save } = useSpacePreviewPreferences();
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [tab, setTab] = useState<SettingsTab>("preview");

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

  const keyLabel = (key: PreviewKey) => t(`shortcutField.presets.${key}`, { defaultValue: key });

  const operations: { keys: string[]; label: string }[] = [
    {
      keys: ["Ctrl+O"],
      label: t("spacePreview.settings.opOpen", { defaultValue: "Select a file" }),
    },
    {
      keys: ["Ctrl+F"],
      label: t("spacePreview.settings.opFind", { defaultValue: "Find in the current file" }),
    },
    {
      keys: ["Space", "Esc"],
      label: t("spacePreview.settings.opClose", { defaultValue: "Close the preview" }),
    },
    {
      keys: [`Shift+${keyLabel(preferences.previewKey)}`],
      label: t("spacePreview.settings.opPlainText", {
        defaultValue: "Open text-like files as plain text",
      }),
    },
    {
      keys: ["Ctrl+=", "Ctrl+-"],
      label: t("spacePreview.settings.opTextSize", {
        defaultValue: "Increase or decrease the text size",
      }),
    },
    {
      keys: [t("spacePreview.settings.opWheel", { defaultValue: "Ctrl + wheel" })],
      label: t("spacePreview.settings.opWheelLabel", {
        defaultValue: "Resize the text with the mouse wheel",
      }),
    },
    {
      keys: ["←", "→"],
      label: t("spacePreview.settings.opFiles", {
        defaultValue: "Previous or next file in the selection",
      }),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.filePreview.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.filePreview.description")}</p>
      </div>

      {/* The master switch stays above the tabs: every tab depends on it. */}
      <div className="border-border rounded-xl border px-4">
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
      </div>

      <div
        role="tablist"
        aria-label={t("settings.filePreview.title")}
        className="border-border bg-muted/40 flex w-fit max-w-full flex-wrap gap-1 rounded-lg border p-1"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === item.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(item.key, { defaultValue: item.fallback })}
          </button>
        ))}
      </div>

      {preferencesLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <div role="tabpanel" className="border-border rounded-xl border px-4">
          {tab === "preview" && (
            <div className="divide-y">
              <Row label={t("spacePreview.settings.readingWidth")}>
                <NumberField
                  value={preferences.readingWidth}
                  min={360}
                  max={2400}
                  unit="px"
                  onChange={(readingWidth) => void updatePreferences({ readingWidth })}
                />
              </Row>
              <Row label={t("spacePreview.settings.fontSize")}>
                <NumberField
                  value={preferences.fontSize}
                  min={10}
                  max={40}
                  unit="px"
                  onChange={(fontSize) => void updatePreferences({ fontSize })}
                />
              </Row>
              <Row
                label={t("spacePreview.settings.font", { defaultValue: "Reading font" })}
                hint={t("spacePreview.settings.fontHint", {
                  defaultValue: "Code and plain text stay monospaced.",
                })}
              >
                <Choice
                  value={preferences.font}
                  onChange={(value) => void updatePreferences({ font: value as PreviewFont })}
                >
                  {previewFonts.map((font) => (
                    <SelectItem key={font} value={font}>
                      {t(FONT_LABELS[font].key, { defaultValue: FONT_LABELS[font].fallback })}
                    </SelectItem>
                  ))}
                </Choice>
              </Row>
              <Row
                label={t("spacePreview.settings.wrap", { defaultValue: "Word wrap" })}
                hint={t("spacePreview.settings.wrapHint", {
                  defaultValue: "Wrap long lines in the text view instead of scrolling sideways.",
                })}
              >
                <Switch
                  checked={preferences.wrap}
                  onCheckedChange={(wrap) => void updatePreferences({ wrap })}
                />
              </Row>
              <Row label={t("spacePreview.settings.defaultEncoding")}>
                <Choice
                  value={preferences.defaultEncoding}
                  onChange={(value) =>
                    void updatePreferences({ defaultEncoding: value as TextEncoding })
                  }
                >
                  {TEXT_ENCODINGS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {t(item.key, { defaultValue: item.fallback })}
                    </SelectItem>
                  ))}
                </Choice>
              </Row>
              <Row
                label={t("spacePreview.settings.textThreshold")}
                hint={t("spacePreview.settings.textThresholdHint")}
                help={t("spacePreview.settings.textThresholdEdit", {
                  defaultValue:
                    "Larger files can be previewed but not edited; editing loads the whole file into the editor.",
                })}
              >
                <NumberField
                  value={preferences.textPreviewThresholdKb}
                  min={1}
                  max={65536}
                  unit="KB"
                  onChange={(textPreviewThresholdKb) =>
                    void updatePreferences({ textPreviewThresholdKb })
                  }
                />
              </Row>
              <Row
                label={t("spacePreview.settings.html", { defaultValue: "HTML default view" })}
                hint={t("spacePreview.settings.htmlHint", {
                  defaultValue: "Choose how an HTML file opens; the viewer can still switch.",
                })}
              >
                <Choice
                  value={preferences.html}
                  onChange={(value) => void updatePreferences({ html: value as PreviewHtmlView })}
                >
                  {previewHtmlViews.map((view) => (
                    <SelectItem key={view} value={view}>
                      {t(HTML_LABELS[view].key, { defaultValue: HTML_LABELS[view].fallback })}
                    </SelectItem>
                  ))}
                </Choice>
              </Row>
            </div>
          )}

          {tab === "resources" && (
            <div className="divide-y">
              <Row
                label={t("spacePreview.settings.maxPreview", {
                  defaultValue: "Single-file preview limit",
                })}
                hint={t("spacePreview.settings.maxPreviewHint", {
                  defaultValue: "Larger files are listed but not read into memory.",
                })}
              >
                <Choice
                  value={String(preferences.maxPreviewMiB)}
                  onChange={(value) => void updatePreferences({ maxPreviewMiB: Number(value) })}
                >
                  {previewSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} MiB
                    </SelectItem>
                  ))}
                </Choice>
              </Row>
              <Row
                label={t("spacePreview.settings.maxArchiveEntry", {
                  defaultValue: "Archive inner-file limit",
                })}
                hint={t("spacePreview.settings.maxArchiveEntryHint", {
                  defaultValue: "The largest file the archive viewer extracts from an archive.",
                })}
              >
                <Choice
                  value={String(preferences.maxArchiveEntryMiB)}
                  onChange={(value) =>
                    void updatePreferences({ maxArchiveEntryMiB: Number(value) })
                  }
                >
                  {archiveSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} MiB
                    </SelectItem>
                  ))}
                </Choice>
              </Row>
              <p className="text-muted-foreground py-3 text-xs">
                {t("spacePreview.settings.resourceNote", {
                  defaultValue:
                    "Parsed content can use more memory than the file itself; raise these limits with care.",
                })}
              </p>
            </div>
          )}

          {tab === "multi" && (
            <div className="divide-y">
              <Row
                label={t("spacePreview.settings.tabs", {
                  defaultValue: "Use file tabs",
                })}
                hint={t("spacePreview.settings.tabsHint", {
                  defaultValue:
                    "When several files are selected, each one opens in a tab you can switch and close.",
                })}
              >
                <Switch
                  checked={preferences.tabs}
                  onCheckedChange={(tabs) => void updatePreferences({ tabs })}
                />
              </Row>
              <p className="text-muted-foreground py-3 text-xs">
                {t("spacePreview.settings.tabsNote", {
                  defaultValue:
                    "With tabs off, the window shows one file at a time and the arrow keys step through the selection.",
                })}
              </p>
            </div>
          )}

          {tab === "shortcuts" && (
            <div className="divide-y">
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {t("spacePreview.settings.previewKey", {
                      defaultValue: "Preview selection",
                    })}
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    {t("spacePreview.settings.previewKeyHint", {
                      defaultValue: "Change it in Settings → Shortcuts → File preview.",
                    })}
                  </div>
                </div>
                <Key>{keyLabel(preferences.previewKey)}</Key>
              </div>
              <div className="py-3">
                <div className="mb-2 text-sm font-medium">
                  {t("spacePreview.settings.commonKeys", { defaultValue: "Common actions" })}
                </div>
                <div className="space-y-1.5">
                  {operations.map((operation) => (
                    <div key={operation.label} className="flex items-center justify-between gap-4">
                      <span className="text-muted-foreground text-xs">{operation.label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {operation.keys.map((key) => (
                          <Key key={key}>{key}</Key>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "guide" && (
            <div className="space-y-3 py-3">
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                <li>
                  {t("spacePreview.settings.guideStep1", {
                    defaultValue: "Select a file in Explorer, on the desktop or in Everything.",
                  })}
                </li>
                <li>
                  {t("spacePreview.settings.guideStep2", {
                    defaultValue: "Press {{key}} to open the preview over the selection.",
                    key: keyLabel(preferences.previewKey),
                  })}
                </li>
                <li>
                  {t("spacePreview.settings.guideStep3", {
                    defaultValue: "Press {{key}} again or Esc to close it.",
                    key: keyLabel(preferences.previewKey),
                  })}
                </li>
              </ol>
              <p className="text-muted-foreground text-xs">
                {t("spacePreview.settings.guidePlainText", {
                  defaultValue:
                    "Hold Shift while pressing the preview key to open a text-like file as plain text.",
                })}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("spacePreview.settings.guideMulti", {
                  defaultValue:
                    "With several files selected, use the arrow keys to move between them.",
                })}
              </p>
              {!preferences.spaceEnabled && (
                <p className="text-muted-foreground rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  {t("spacePreview.settings.guideDisabled", {
                    defaultValue: "The space preview switch is off; turn it on above to use it.",
                  })}
                </p>
              )}
              {preferences.spaceEnabled && agent && !agent.running && (
                <p className="text-muted-foreground rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  {t("spacePreview.settings.guideNotRunning", {
                    defaultValue:
                      "The space handler is enabled but not running; restart the app if this persists.",
                  })}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {t("spacePreview.settings.autoSave", { defaultValue: "Changes save automatically." })}
      </p>
    </div>
  );
}
