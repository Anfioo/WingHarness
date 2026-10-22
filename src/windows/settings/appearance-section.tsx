import { useMemo, useState } from "react";
import { Check, Monitor, Moon, Search, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LanguageToggle } from "@/components/toggle/language-toggle";
import { resolveMode, useTheme } from "@/components/theme-provider";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { DEFAULT_PRESET_ID, THEME_PRESETS, previewColors } from "@/lib/theme/presets";

/** The card face: the preset's own colors, so a choice is judged off the theme itself. */
function PresetPreview({ id, mode }: { id: string; mode: "light" | "dark" }) {
  const colors = previewColors(id, mode);
  return (
    <span
      className="flex h-16 flex-col justify-between border-b p-2"
      style={{ backgroundColor: colors.background, borderColor: colors.border }}
    >
      <span className="text-sm leading-none font-semibold" style={{ color: colors.foreground }}>
        Aa
      </span>
      <span className="flex items-center gap-1">
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colors.primary }} />
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colors.secondary }} />
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colors.accent }} />
        <span
          className="ms-auto h-3 w-8 rounded-sm border"
          style={{ borderColor: colors.border }}
        />
      </span>
    </span>
  );
}

/** Only rendered inside `WindowFrame`, which is what mounts the `ThemeProvider` this reads. */
export function AppearanceSection() {
  const { t } = useAppTranslation();
  const { theme, setTheme, preset, setPreset } = useTheme();
  const [query, setQuery] = useState("");

  const mode = resolveMode(theme);

  // The default theme has no entry of its own — it is what the stylesheet already
  // says — so its card is built here and pinned to the front.
  const cards = useMemo(() => {
    const all = [
      { id: DEFAULT_PRESET_ID, label: t("settings.appearance.presetDefault") },
      ...THEME_PRESETS.map(({ id, label }) => ({ id, label })),
    ];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      ({ id, label }) => label.toLowerCase().includes(needle) || id.toLowerCase().includes(needle)
    );
  }, [query, t]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.appearance.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.appearance.description")}</p>
      </div>

      <div className="space-y-0">
        <div className="flex items-center justify-between py-2.5">
          <label className="text-sm font-medium">{t("settings.appearance.theme")}</label>
          <div className="flex gap-2">
            <Button
              variant={theme === "light" ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme("light")}
              className="flex items-center gap-1.5"
            >
              <Sun className="h-3.5 w-3.5" />
              {t("settings.appearance.light")}
            </Button>
            <Button
              variant={theme === "dark" ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme("dark")}
              className="flex items-center gap-1.5"
            >
              <Moon className="h-3.5 w-3.5" />
              {t("settings.appearance.dark")}
            </Button>
            <Button
              variant={theme === "system" ? "default" : "outline"}
              size="sm"
              onClick={() => setTheme("system")}
              className="flex items-center gap-1.5"
            >
              <Monitor className="h-3.5 w-3.5" />
              {t("settings.appearance.system")}
            </Button>
          </div>
        </div>

        <div className="border-t" />

        <div className="flex items-center justify-between py-2.5">
          <label className="text-sm font-medium">{t("settings.appearance.language")}</label>
          <LanguageToggle />
        </div>
      </div>

      <div className="border-t" />

      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t("settings.appearance.preset")}</label>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("settings.appearance.presetFontsHint")}
          </p>
        </div>

        <div className="relative">
          <Search className="text-muted-foreground absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("settings.appearance.presetSearch")}
            className="h-8 ps-8 text-sm"
          />
        </div>

        {cards.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t("settings.appearance.presetNoResults")}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {cards.map(({ id, label }) => {
              const active = preset === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPreset(id)}
                  aria-pressed={active}
                  className={cn(
                    "overflow-hidden rounded-lg border text-left transition-colors",
                    active ? "border-primary ring-primary ring-1" : "hover:border-foreground/30"
                  )}
                >
                  <PresetPreview id={id} mode={mode} />
                  <span className="flex items-center gap-1 px-2 py-1.5">
                    <span className="truncate text-xs">{label}</span>
                    {active && <Check className="text-primary ms-auto h-3.5 w-3.5 shrink-0" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
