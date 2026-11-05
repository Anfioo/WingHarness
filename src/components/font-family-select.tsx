import { Fragment } from "react";
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
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useInstalledFonts } from "@/lib/fonts/installed";
import { cleanFontFamily, monoFontStack } from "@/lib/fonts/stack";

/** Radix selects cannot carry an empty value, so "no choice" gets a sentinel. */
const DEFAULT_VALUE = "__default__";

export type FontFamilySelectProps = {
  /** Family name; an empty string means the caller's own default. */
  value: string;
  onChange: (family: string) => void;
  /** List monospace families first — the natural order for code and terminals. */
  monospaceFirst?: boolean;
  /** Offers an entry that maps back to an empty value, labelled with this. */
  defaultLabel?: string;
  /** Stack that draws the family names and the preview. Defaults to monospace. */
  stackFor?: (family: string) => string;
  /** Sample text drawn in the chosen family below the field. */
  preview?: string;
  className?: string;
  disabled?: boolean;
};

/**
 * Picker over the fonts installed on the system, grouped by whether they are
 * monospaced so a code font is not hunted down in a list of display faces.
 *
 * Every family name is drawn in its own face, which is the only reliable way
 * to tell two fonts apart when the names are all the user has to go on.
 */
export function FontFamilySelect({
  value,
  onChange,
  monospaceFirst = true,
  defaultLabel,
  stackFor = monoFontStack,
  preview,
  className,
  disabled,
}: FontFamilySelectProps) {
  const { t } = useAppTranslation();
  const { fonts, loading } = useInstalledFonts();

  const monospace = fonts.filter((font) => font.monospaced);
  const other = fonts.filter((font) => !font.monospaced);
  const family = cleanFontFamily(value);

  // A family saved on another machine, or typed as a whole stack, is kept as a
  // selectable entry so opening the picker does not silently drop the choice.
  const missing =
    family !== "" && !loading && !fonts.some((font) => cleanFontFamily(font.family) === family);

  const groups = monospaceFirst
    ? ([
        ["monospace", monospace],
        ["other", other],
      ] as const)
    : ([
        ["other", other],
        ["monospace", monospace],
      ] as const);

  return (
    <div className={className}>
      <Select
        value={defaultLabel && family === "" ? DEFAULT_VALUE : family}
        onValueChange={(next) => onChange(next === DEFAULT_VALUE ? "" : next)}
        disabled={disabled || loading}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t("settings.fonts.loading")} />
        </SelectTrigger>
        <SelectContent>
          {defaultLabel ? <SelectItem value={DEFAULT_VALUE}>{defaultLabel}</SelectItem> : null}
          {missing ? (
            <SelectItem value={family}>
              <span style={{ fontFamily: stackFor(family) }}>{family}</span>
              <span className="text-muted-foreground">{t("settings.fonts.notInstalled")}</span>
            </SelectItem>
          ) : null}
          {groups.map(([key, list]) =>
            list.length === 0 ? null : (
              <Fragment key={key}>
                <SelectSeparator />
                {/* The label names the group, so it has to sit inside it. */}
                <SelectGroup>
                  <SelectLabel>{t(`settings.fonts.groups.${key}`)}</SelectLabel>
                  {list.map((font) => (
                    <SelectItem key={font.family} value={cleanFontFamily(font.family)}>
                      <span style={{ fontFamily: stackFor(font.family) }}>{font.family}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </Fragment>
            )
          )}
        </SelectContent>
      </Select>

      {preview ? (
        <div
          className="bg-muted/40 text-muted-foreground mt-1.5 truncate rounded-md border px-3 py-2 text-xs"
          style={{ fontFamily: stackFor(family) }}
        >
          {preview}
        </div>
      ) : null}
    </div>
  );
}
