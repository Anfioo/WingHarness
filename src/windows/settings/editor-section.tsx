import { useEffect, useRef, useState } from "react";
import { Editor, type Theme } from "codelet";
import { Check, Moon, RotateCcw, Sun, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listLocalShellFonts } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  DEFAULT_EDITOR_PREFS,
  DEFAULT_FONT_FAMILY,
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  loadEditorPrefs,
  saveEditorPrefs,
  type EditorPrefs,
} from "@/lib/editor/prefs";
import { themesFor } from "@/lib/editor/themes";
import { applyEditorTypography } from "@/lib/editor/typography";

/** Class the draft stylesheet is scoped to, so the preview shows unsaved edits. */
const PREVIEW_CLASS = "editor-preview";
const PREVIEW_STYLE_ID = "editor-preview-typography";

/** A little Markdown, so a preview shows the token colours a note would. */
const PREVIEW_DOC = `# 标题

正文、**加粗**、\`行内代码\`。

- 列表项
- [链接](https://example.com)

\`\`\`ts
const theme = "codelet";
\`\`\`
`;

/**
 * A read-only editor in the given theme, so a choice is judged on the real
 * colours rather than a swatch. Mounted through codelet's own `Editor`, which
 * is the same view every page uses.
 */
function EditorPreview({ theme }: { theme: Theme }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = new Editor({
      parent: host,
      doc: PREVIEW_DOC,
      lang: "md",
      readOnly: true,
      theme,
    });
    editorRef.current = editor;
    return () => {
      editor.destroy();
      editorRef.current = null;
    };
    // Mount once; the theme is applied by the effect below, which also covers
    // a later change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once per host
  }, []);

  useEffect(() => {
    editorRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <div
      ref={hostRef}
      className={`${PREVIEW_CLASS} border-border h-44 overflow-hidden rounded-md border [&_.cm-scroller]:overflow-hidden`}
    />
  );
}

/**
 * A row of colour chips standing in for the code a theme paints: the chrome it
 * shades plus a few of its token colours. Enough to tell two palettes apart
 * without mounting an editor per option.
 */
function ThemeSwatch({ theme }: { theme: Theme }) {
  const tokens = Object.values(theme.tokens).slice(0, 4);
  return (
    <span
      className="border-border flex overflow-hidden rounded-[3px] border"
      style={{ background: theme.bg }}
    >
      {tokens.map((token, index) => (
        <span key={index} className="h-3 w-1.5" style={{ background: token.color ?? theme.fg }} />
      ))}
    </span>
  );
}

/** One mode's picker: a labelled select over that side's palettes. */
function ThemePicker({
  mode,
  value,
  onChange,
}: {
  mode: "light" | "dark";
  value: string;
  onChange: (name: string) => void;
}) {
  const { t } = useAppTranslation();
  const options = themesFor(mode === "dark");
  const Icon = mode === "dark" ? Moon : Sun;
  const selected = options.find((theme) => theme.name === value);

  return (
    <div className="space-y-2 py-3">
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-4" />
        <label className="text-sm font-medium">
          {mode === "dark" ? t("editor.darkTheme") : t("editor.lightTheme")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">
        {mode === "dark" ? t("editor.darkThemeHint") : t("editor.lightThemeHint")}
      </p>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue>
            {selected ? (
              <span className="flex items-center gap-2">
                <ThemeSwatch theme={selected} />
                {selected.name}
              </span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((theme) => (
            <SelectItem key={theme.name} value={theme.name}>
              <span className="flex items-center gap-2">
                <ThemeSwatch theme={theme} />
                {theme.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A labelled number input, clamped so a stray keystroke cannot break the layout. */
function NumberField({
  label,
  hint,
  unit,
  step,
  range,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  unit?: string;
  step: number;
  range: { min: number; max: number };
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex-1">
        <label className="text-sm font-medium">{label}</label>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="w-24"
          value={value}
          min={range.min}
          max={range.max}
          step={step}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (!Number.isFinite(n)) return;
            onChange(Math.min(range.max, Math.max(range.min, n)));
          }}
        />
        {unit ? <span className="text-muted-foreground w-8 text-xs">{unit}</span> : null}
      </div>
    </div>
  );
}

/**
 * The editor's appearance, shared by every surface that mounts one — the notes
 * page today, and any other editor added later.
 *
 * Two halves: the palettes, chosen per light/dark mode so switching the app to
 * dark lands on a palette picked for dark rather than the light choice washed
 * out; and the typography, which is mode-independent. Both are previewed live
 * against the draft being edited, before it is saved.
 */
export function EditorSection() {
  const { t } = useAppTranslation();
  const [prefs, setPrefs] = useState<EditorPrefs>(() => loadEditorPrefs());
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    listLocalShellFonts()
      .then((list) => setFonts(list.sort((a, b) => a.localeCompare(b))))
      .catch(() => setFonts([]));
  }, []);

  const update = (patch: Partial<EditorPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveEditorPrefs(next);
  };

  const lightTheme = themesFor(false).find((theme) => theme.name === prefs.lightTheme);
  const darkTheme = themesFor(true).find((theme) => theme.name === prefs.darkTheme);

  // The preview tracks the draft, so an unsaved change is visible before it is
  // written; the pages themselves read the saved value. Its own stylesheet id
  // keeps it from disturbing what those pages are already using.
  useEffect(() => {
    applyEditorTypography(prefs, { scope: `.${PREVIEW_CLASS}`, id: PREVIEW_STYLE_ID });
  }, [prefs]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("editor.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("editor.description")}</p>
      </div>

      {/* Themes */}
      <div className="divide-y">
        <ThemePicker
          mode="light"
          value={prefs.lightTheme}
          onChange={(lightTheme) => update({ lightTheme })}
        />
        <ThemePicker
          mode="dark"
          value={prefs.darkTheme}
          onChange={(darkTheme) => update({ darkTheme })}
        />
      </div>

      {/* Typography */}
      <div className="space-y-0 divide-y border-t pt-3">
        <div className="py-2.5">
          <div className="flex items-center gap-2">
            <Type className="text-muted-foreground size-4" />
            <label className="text-sm font-medium">{t("editor.fontFamily")}</label>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">{t("editor.fontFamilyHint")}</p>
          <Input
            list="settings-editor-fonts"
            className="mt-1.5"
            value={prefs.fontFamily}
            spellCheck={false}
            onChange={(event) => update({ fontFamily: event.target.value })}
            placeholder={DEFAULT_FONT_FAMILY}
          />
          <datalist id="settings-editor-fonts">
            {fonts.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <p className="text-muted-foreground mt-1 text-xs">
            {fonts.length > 0
              ? t("editor.fontsDetected", { count: fonts.length })
              : t("editor.fontsLoading")}
          </p>
        </div>

        <NumberField
          label={t("editor.fontSize")}
          unit="px"
          step={1}
          range={FONT_SIZE_RANGE}
          value={prefs.fontSize}
          onChange={(fontSize) => update({ fontSize })}
        />
        <NumberField
          label={t("editor.lineHeight")}
          hint={t("editor.lineHeightHint")}
          step={0.1}
          range={LINE_HEIGHT_RANGE}
          value={prefs.lineHeight}
          onChange={(lineHeight) => update({ lineHeight })}
        />

        <div className="flex items-center justify-between py-2.5">
          <div className="flex-1">
            <label className="text-sm font-medium">{t("editor.lineNumbers")}</label>
            <p className="text-muted-foreground mt-0.5 text-xs">{t("editor.lineNumbersHint")}</p>
          </div>
          <input
            type="checkbox"
            checked={prefs.lineNumbers}
            onChange={(event) => update({ lineNumbers: event.target.checked })}
            className="accent-primary size-4"
          />
        </div>
      </div>

      {/* Views */}
      <div className="space-y-0 divide-y border-t pt-3">
        <div className="flex items-center justify-between py-2.5">
          <div className="flex-1">
            <label className="text-sm font-medium">{t("editor.extensionsView")}</label>
            <p className="text-muted-foreground mt-0.5 text-xs">{t("editor.extensionsViewHint")}</p>
          </div>
          <input
            type="checkbox"
            checked={prefs.extensionsView}
            onChange={(event) => update({ extensionsView: event.target.checked })}
            className="accent-primary size-4"
          />
        </div>
      </div>

      {/* Preview */}
      <div className="space-y-2 border-t pt-3">
        <p className="text-sm font-medium">{t("editor.preview")}</p>
        <div className="grid grid-cols-2 gap-3">
          {lightTheme && (
            <div className="space-y-1.5">
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Sun className="size-3.5" />
                {t("editor.lightTheme")}
              </span>
              <EditorPreview theme={lightTheme} />
            </div>
          )}
          {darkTheme && (
            <div className="space-y-1.5">
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Moon className="size-3.5" />
                {t("editor.darkTheme")}
              </span>
              <EditorPreview theme={darkTheme} />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => update({ ...DEFAULT_EDITOR_PREFS })}>
          <RotateCcw className="size-4" />
          {t("editor.reset")}
        </Button>
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          <Check className="size-3.5" />
          {t("editor.appliesImmediately")}
        </span>
      </div>
    </div>
  );
}
