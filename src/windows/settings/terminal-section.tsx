import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInstalledFonts } from "@/lib/fonts/installed";
import { cleanFontFamily, monoFontStack } from "@/lib/fonts/stack";
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
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => loadTerminalPrefs());
  const { fonts, loading } = useInstalledFonts();

  const update = (patch: Partial<TerminalPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveTerminalPrefs(next);
  };

  const monospace = fonts.filter((font) => font.monospaced);
  const other = fonts.filter((font) => !font.monospaced);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">终端</h2>
        <p className="text-muted-foreground text-sm">本地终端页签的字体、字号与显示行为。</p>
      </div>

      <div className="space-y-0 divide-y">
        <div className="py-2.5">
          <label className="text-sm font-medium">字体</label>
          <Select
            value={cleanFontFamily(prefs.fontFamily)}
            onValueChange={(value) => update({ fontFamily: value })}
            disabled={loading}
          >
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue placeholder={loading ? "正在加载系统字体…" : "选择字体"} />
            </SelectTrigger>
            <SelectContent>
              {monospace.length > 0 && (
                <SelectGroup>
                  <SelectLabel>等宽字体</SelectLabel>
                  {monospace.map((font) => (
                    <SelectItem key={font.family} value={cleanFontFamily(font.family)}>
                      <span style={{ fontFamily: monoFontStack(font.family) }}>{font.family}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {other.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>其他字体</SelectLabel>
                    {other.map((font) => (
                      <SelectItem key={font.family} value={cleanFontFamily(font.family)}>
                        <span style={{ fontFamily: `"${cleanFontFamily(font.family)}"` }}>
                          {font.family}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>
          {/* Font family names are drawn in their own face, like the git settings. */}
          <div
            className="bg-muted/40 mt-1.5 rounded-md border px-3 py-2 text-xs"
            style={{ fontFamily: monoFontStack(prefs.fontFamily) }}
          >
            {PREVIEW}
          </div>
        </div>

        <NumberField
          label="字号"
          unit="px"
          value={prefs.fontSize}
          onChange={(n) => update({ fontSize: n })}
        />
        <NumberField
          label="Tab 宽度"
          value={prefs.tabStopWidth}
          onChange={(n) => update({ tabStopWidth: n })}
        />
        <ToggleRow
          label="自动换行"
          hint="长行在终端内自动折行，减少横向滚动。"
          checked={prefs.autoWrap}
          onChange={(v) => update({ autoWrap: v })}
        />
        <ToggleRow
          label="高亮当前行"
          hint="当前光标所在行显示轻量标记。"
          checked={prefs.highlightCurrentLine}
          onChange={(v) => update({ highlightCurrentLine: v })}
        />
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => update({ ...DEFAULT_TERMINAL_PREFS })}>
          恢复默认
        </Button>
      </div>
    </div>
  );
}
