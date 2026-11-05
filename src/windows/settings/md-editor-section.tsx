import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  mdEditorSettingsGet,
  mdEditorSettingsSet,
  type AppearanceSettings,
  type BehaviorSettings,
  type ExportSettings,
  type MdEditorSettings,
  type ViewMode,
  type ViewSettings,
} from "@/commands";
import { FontFamilySelect } from "@/components/font-family-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { interfaceFontStack, monoFontStack } from "@/lib/fonts/stack";

/** How long a text or number edit waits before the whole settings object is written. */
const SAVE_DELAY_MS = 400;

const FONT_SIZE_RANGE = { min: 10, max: 24 };
const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.4 };
const CONTENT_WIDTH_RANGE = { min: 480, max: 1600 };
const TAB_SIZE_RANGE = { min: 1, max: 8 };
const AUTO_SAVE_INTERVAL_RANGE = { min: 5, max: 600 };
const SPLIT_RATIO_RANGE = { min: 0.2, max: 0.8 };
const OUTLINE_WIDTH_RANGE = { min: 160, max: 400 };
const IMAGE_SCALE_RANGE = { min: 1, max: 3 };
const PDF_MARGIN_RANGE = { min: 0, max: 50 };

const VIEW_MODE_OPTIONS: { value: ViewMode; labelKey: string }[] = [
  { value: "read", labelKey: "mdEditor.view.read" },
  { value: "source", labelKey: "mdEditor.view.source" },
  { value: "split", labelKey: "mdEditor.view.split" },
];

/** Glyphs that tell monospaced faces apart, so the preview is worth looking at. */
const CODE_PREVIEW = "const value = 0O1; // → ✓ ≠ λ 1lI";

// "A4" and "Letter" are page names, not translated copy.
const PDF_PAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
];

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
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
      </div>
      <div className="w-72 shrink-0">{children}</div>
    </div>
  );
}

/**
 * A number input that lets the field be empty while typing and only commits a
 * value on blur or Enter. Out-of-range values are pulled to the nearest bound
 * rather than dropped, so 999 in a 10–24 field becomes 24 on blur.
 */
function NumberField({
  label,
  hint,
  unit,
  step,
  range,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  unit?: string;
  step: number;
  range: { min: number; max: number };
  value: number;
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
    const next = Math.min(range.max, Math.max(range.min, parsed));
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="w-24"
          value={text}
          min={range.min}
          max={range.max}
          step={step}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {unit ? <span className="text-muted-foreground text-xs">{unit}</span> : null}
      </div>
    </Row>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-6">
      {[0, 1, 2, 3].map((group) => (
        <div key={group} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The Markdown editor's settings partition.
 *
 * The whole settings object is written back on every change, so a bad field
 * never leaks into the others. Switches and selects save at once; typed values
 * wait for a short pause so a single word does not cost a disk write per key.
 * The backend is the last clamp, but the form clamps first so the field the
 * user sees always matches the value that was stored.
 */
export function MdEditorSection() {
  const { t } = useAppTranslation();

  const [draft, setDraft] = useState<MdEditorSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // The debounce timer and the value it will write live outside React state:
  // they are bookkeeping, not something the form renders.
  const draftRef = useRef<MdEditorSettings | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<MdEditorSettings | null>(null);

  const persist = useCallback(
    async (next: MdEditorSettings) => {
      try {
        await mdEditorSettingsSet(next);
        // An editor that is already open in another window applies the change
        // as soon as it hears about it instead of waiting for a restart.
        await emit("md-editor-settings-changed");
      } catch (error: unknown) {
        console.error("Failed to save the Markdown editor settings:", error);
        toast.error(t("mdEditor.settings.saveFailed"));
      }
    },
    [t]
  );

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    mdEditorSettingsGet()
      .then((next) => {
        draftRef.current = next;
        setDraft(next);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the Markdown editor settings:", error);
        setFailed(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
  }, []);

  // Switching to another section unmounts the form; write the pending edit
  // instead of letting the debounce expire into nothing.
  useEffect(() => {
    return () => {
      const pending = pendingRef.current;
      cancelPending();
      if (pending) void persist(pending);
    };
  }, [cancelPending, persist]);

  /** Apply a change to the draft and schedule how it reaches disk. */
  const update = useCallback(
    (producer: (current: MdEditorSettings) => MdEditorSettings, immediate = false) => {
      const current = draftRef.current;
      if (!current) return;
      const next = producer(current);
      draftRef.current = next;
      setDraft(next);
      cancelPending();
      if (immediate) {
        void persist(next);
        return;
      }
      pendingRef.current = next;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingRef.current = null;
        void persist(next);
      }, SAVE_DELAY_MS);
    },
    [cancelPending, persist]
  );

  const updateAppearance = (changes: Partial<AppearanceSettings>, immediate = false) =>
    update(
      (current) => ({ ...current, appearance: { ...current.appearance, ...changes } }),
      immediate
    );

  const updateBehavior = (changes: Partial<BehaviorSettings>, immediate = false) =>
    update((current) => ({ ...current, behavior: { ...current.behavior, ...changes } }), immediate);

  const updateView = (changes: Partial<ViewSettings>, immediate = false) =>
    update((current) => ({ ...current, view: { ...current.view, ...changes } }), immediate);

  const updateExport = (changes: Partial<ExportSettings>, immediate = false) =>
    update((current) => ({ ...current, export: { ...current.export, ...changes } }), immediate);

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold">{t("mdEditor.settings.title")}</h2>
        <SkeletonRows />
      </div>
    );
  }

  if (failed || !draft) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t("mdEditor.settings.title")}</h2>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">{t("mdEditor.settings.loadFailed")}</span>
          <Button size="sm" variant="outline" onClick={load}>
            {t("mdEditor.settings.retry")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t("mdEditor.settings.title")}</h2>

      <section>
        <h3 className="text-sm font-semibold">{t("mdEditor.settings.appearance.title")}</h3>
        <div className="divide-y">
          <Row
            label={t("mdEditor.settings.appearance.fontFamily")}
            hint={t("mdEditor.settings.appearance.fontFamilyHint")}
          >
            <FontFamilySelect
              value={draft.appearance.fontFamily}
              onChange={(fontFamily) => updateAppearance({ fontFamily }, true)}
              defaultLabel={t("mdEditor.settings.appearance.fontFamilyDefault")}
              stackFor={interfaceFontStack}
              preview={t("mdEditor.settings.appearance.fontPreview")}
            />
          </Row>

          <NumberField
            label={t("mdEditor.settings.appearance.fontSize")}
            unit="px"
            step={1}
            range={FONT_SIZE_RANGE}
            value={draft.appearance.fontSize}
            onChange={(fontSize) => updateAppearance({ fontSize })}
          />

          <NumberField
            label={t("mdEditor.settings.appearance.lineHeight")}
            step={0.1}
            range={LINE_HEIGHT_RANGE}
            value={draft.appearance.lineHeight}
            onChange={(lineHeight) => updateAppearance({ lineHeight })}
          />

          <NumberField
            label={t("mdEditor.settings.appearance.contentWidth")}
            unit="px"
            step={10}
            range={CONTENT_WIDTH_RANGE}
            value={draft.appearance.contentWidth}
            onChange={(contentWidth) => updateAppearance({ contentWidth })}
          />

          <Row
            label={t("mdEditor.settings.appearance.codeFontFamily")}
            hint={t("mdEditor.settings.appearance.codeFontFamilyHint")}
          >
            <FontFamilySelect
              value={draft.appearance.codeFontFamily}
              onChange={(codeFontFamily) => updateAppearance({ codeFontFamily }, true)}
              defaultLabel={t("mdEditor.settings.appearance.codeFontFamilyDefault")}
              stackFor={monoFontStack}
              preview={CODE_PREVIEW}
            />
          </Row>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold">{t("mdEditor.settings.behavior.title")}</h3>
        <div className="divide-y">
          <Row label={t("mdEditor.settings.behavior.lineWrap")}>
            <div className="flex justify-end">
              <Switch
                checked={draft.behavior.lineWrap}
                onCheckedChange={(checked) => updateBehavior({ lineWrap: checked }, true)}
              />
            </div>
          </Row>

          <Row label={t("mdEditor.settings.behavior.lineNumbers")}>
            <div className="flex justify-end">
              <Switch
                checked={draft.behavior.lineNumbers}
                onCheckedChange={(checked) => updateBehavior({ lineNumbers: checked }, true)}
              />
            </div>
          </Row>

          <NumberField
            label={t("mdEditor.settings.behavior.tabSize")}
            step={1}
            range={TAB_SIZE_RANGE}
            value={draft.behavior.tabSize}
            onChange={(tabSize) => updateBehavior({ tabSize })}
          />

          <Row label={t("mdEditor.settings.behavior.autoSave")}>
            <div className="flex justify-end">
              <Switch
                checked={draft.behavior.autoSave}
                onCheckedChange={(checked) => updateBehavior({ autoSave: checked }, true)}
              />
            </div>
          </Row>

          <NumberField
            label={t("mdEditor.settings.behavior.autoSaveInterval")}
            step={1}
            range={AUTO_SAVE_INTERVAL_RANGE}
            value={draft.behavior.autoSaveIntervalSec}
            disabled={!draft.behavior.autoSave}
            onChange={(autoSaveIntervalSec) => updateBehavior({ autoSaveIntervalSec })}
          />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold">{t("mdEditor.settings.view.title")}</h3>
        <div className="divide-y">
          <Row label={t("mdEditor.settings.view.defaultMode")}>
            <Select
              value={draft.view.defaultMode}
              onValueChange={(value) => updateView({ defaultMode: value as ViewMode }, true)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIEW_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row label={t("mdEditor.settings.view.splitRatio")}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                className="accent-primary h-1.5 w-full cursor-pointer"
                min={SPLIT_RATIO_RANGE.min}
                max={SPLIT_RATIO_RANGE.max}
                step={0.05}
                value={draft.view.splitRatio}
                onChange={(event) => updateView({ splitRatio: Number(event.target.value) })}
              />
              <span className="text-muted-foreground w-10 shrink-0 text-right text-xs tabular-nums">
                {Math.round(draft.view.splitRatio * 100)}%
              </span>
            </div>
          </Row>

          <Row label={t("mdEditor.settings.view.outlineVisible")}>
            <div className="flex justify-end">
              <Switch
                checked={draft.view.outlineVisible}
                onCheckedChange={(checked) => updateView({ outlineVisible: checked }, true)}
              />
            </div>
          </Row>

          <NumberField
            label={t("mdEditor.settings.view.outlineWidth")}
            unit="px"
            step={10}
            range={OUTLINE_WIDTH_RANGE}
            value={draft.view.outlineWidth}
            onChange={(outlineWidth) => updateView({ outlineWidth })}
          />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold">{t("mdEditor.settings.export.title")}</h3>
        <div className="divide-y">
          <Row label={t("mdEditor.settings.export.includeStyles")}>
            <div className="flex justify-end">
              <Switch
                checked={draft.export.htmlInlineStyles}
                onCheckedChange={(checked) => updateExport({ htmlInlineStyles: checked }, true)}
              />
            </div>
          </Row>

          <Row label={t("mdEditor.settings.export.includeTitle")}>
            <div className="flex justify-end">
              <Switch
                checked={draft.export.htmlIncludeTitle}
                onCheckedChange={(checked) => updateExport({ htmlIncludeTitle: checked }, true)}
              />
            </div>
          </Row>

          <NumberField
            label={t("mdEditor.settings.export.imageScale")}
            unit="×"
            step={0.25}
            range={IMAGE_SCALE_RANGE}
            value={draft.export.imageScale}
            onChange={(imageScale) => updateExport({ imageScale })}
          />

          <Row label={t("mdEditor.settings.export.includeOutline")}>
            <div className="flex justify-end">
              <Switch
                checked={draft.export.imageIncludeOutline}
                onCheckedChange={(checked) => updateExport({ imageIncludeOutline: checked }, true)}
              />
            </div>
          </Row>

          <Row label={t("mdEditor.settings.export.pdfPage")}>
            <Select
              value={draft.export.pdfPage}
              onValueChange={(value) => updateExport({ pdfPage: value }, true)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PDF_PAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <NumberField
            label={t("mdEditor.settings.export.pdfMargin")}
            unit="mm"
            step={1}
            range={PDF_MARGIN_RANGE}
            value={draft.export.pdfMarginMm}
            onChange={(pdfMarginMm) => updateExport({ pdfMarginMm })}
          />
        </div>
      </section>
    </div>
  );
}
