import { useState } from "react";
import { FontFamilySelect } from "@/components/font-family-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  loadTerminalPrefs,
  saveTerminalPrefs,
  DEFAULT_TERMINAL_PREFS,
  type TerminalPrefs,
} from "@/pages/local-terminal/prefs";

/** Sample text for the font preview, showing the glyphs terminals care about. */
const PREVIEW = "C:\\Users> git status  →  ✓  λ ≠ ≥  0O 1lI";

function NumberField({
  label,
  hint,
  unit,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  unit?: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex-1">
        <label className="text-sm font-medium">{label}</label>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="w-24"
          value={value}
          min={1}
          max={64}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
        />
        {unit ? <span className="text-muted-foreground text-xs">{unit}</span> : null}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex-1">
        <label className="text-sm font-medium">{label}</label>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary size-4"
      />
    </div>
  );
}

export function TerminalSection() {
  const { t } = useAppTranslation();
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => loadTerminalPrefs());

  const update = (patch: Partial<TerminalPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveTerminalPrefs(next);
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.terminal.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.terminal.description")}</p>
      </div>

      <div className="space-y-0 divide-y">
        <div className="py-2.5">
          <label className="text-sm font-medium">{t("settings.terminal.font")}</label>
          <FontFamilySelect
            className="mt-1.5"
            value={prefs.fontFamily}
            onChange={(fontFamily) => update({ fontFamily })}
            preview={PREVIEW}
          />
        </div>

        <NumberField
          label={t("settings.terminal.fontSize")}
          unit="px"
          value={prefs.fontSize}
          onChange={(n) => update({ fontSize: n })}
        />
        <NumberField
          label={t("settings.terminal.tabStopWidth")}
          value={prefs.tabStopWidth}
          onChange={(n) => update({ tabStopWidth: n })}
        />
        <ToggleRow
          label={t("settings.terminal.autoWrap")}
          hint={t("settings.terminal.autoWrapHint")}
          checked={prefs.autoWrap}
          onChange={(v) => update({ autoWrap: v })}
        />
        <ToggleRow
          label={t("settings.terminal.highlightCurrentLine")}
          hint={t("settings.terminal.highlightCurrentLineHint")}
          checked={prefs.highlightCurrentLine}
          onChange={(v) => update({ highlightCurrentLine: v })}
        />
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => update({ ...DEFAULT_TERMINAL_PREFS })}>
          {t("settings.terminal.reset")}
        </Button>
      </div>
    </div>
  );
}
