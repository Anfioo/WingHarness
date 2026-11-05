import { Fragment } from "react";
import type { FontFamily } from "@/commands";
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
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useInstalledFonts } from "@/lib/fonts/installed";
import { useGitSettings } from "./store";
import { Field, SettingCard } from "./SettingCard";
import {
  CODE_FONT_DEFAULT,
  INTERFACE_FONT_DEFAULT,
  cleanFontFamily,
  interfaceFontStack,
  monoFontStack,
} from "@/lib/fonts/stack";

const PREVIEW = "git status  ➜  main ✓   λ → ≠ ≥   0O 1lI";

const DEFAULT_VALUE = "__default__";

function FontName({ name, stack }: { name: string; stack: string }) {
  return <span style={{ fontFamily: stack }}>{name}</span>;
}

function isMissing(value: string | null, fonts: readonly FontFamily[], loading: boolean): boolean {
  if (!value || loading) return false;
  return !fonts.some((font) => cleanFontFamily(font.family) === cleanFontFamily(value));
}

function FontSelect({
  value,
  onChange,
  fonts,
  loading,
  monospaceFirst,
  defaultFamily,
  defaultLabel,
  ariaLabel,
  stackFor,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  fonts: readonly FontFamily[];
  loading: boolean;
  monospaceFirst: boolean;
  defaultFamily: string;
  defaultLabel: string;
  ariaLabel: string;
  stackFor: (family: string | null) => string;
}) {
  const { t } = useAppTranslation();
  const monospace = fonts.filter((font) => font.monospaced);
  const other = fonts.filter((font) => !font.monospaced);
  const groups = monospaceFirst
    ? ([
        ["monospace", monospace],
        ["other", other],
      ] as const)
    : ([
        ["other", other],
        ["monospace", monospace],
      ] as const);
  const missing = isMissing(value, fonts, loading);

  return (
    <Select
      value={value ?? DEFAULT_VALUE}
      onValueChange={(next) => onChange(next === DEFAULT_VALUE ? null : next)}
      disabled={loading}
    >
      <SelectTrigger className="w-full" aria-label={ariaLabel}>
        <SelectValue placeholder={t("gitRepo.extras.fonts.reading")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VALUE}>
          <FontName name={defaultFamily} stack={stackFor(defaultFamily)} />
          <span className="text-muted-foreground">({defaultLabel})</span>
        </SelectItem>
        {missing && value && (
          <SelectItem value={value}>
            <FontName name={value} stack={stackFor(value)} />
            <span className="text-muted-foreground">{t("gitRepo.extras.fonts.notInstalled")}</span>
          </SelectItem>
        )}
        {groups.map(([key, list]) =>
          list.length === 0 ? null : (
            <Fragment key={key}>
              <SelectSeparator />
              {/* A SelectLabel is the group's accessible name, so it has to sit
                  inside the group it labels — nesting it the other way round
                  makes Radix throw "SelectLabel must be used within SelectGroup". */}
              <SelectGroup>
                <SelectLabel>{t(`gitRepo.extras.fonts.groups.${key}`)}</SelectLabel>
                {list.map((font) => (
                  <SelectItem key={font.family} value={cleanFontFamily(font.family)}>
                    <FontName name={font.family} stack={stackFor(font.family)} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </Fragment>
          )
        )}
      </SelectContent>
    </Select>
  );
}

export function FontsCard() {
  const { t } = useAppTranslation();
  const { fonts, loading } = useInstalledFonts();
  const interfaceFontFamily = useGitSettings((state) => state.interfaceFontFamily);
  const codeFontFamily = useGitSettings((state) => state.codeFontFamily);
  const setInterfaceFontFamily = useGitSettings((state) => state.setInterfaceFontFamily);
  const setCodeFontFamily = useGitSettings((state) => state.setCodeFontFamily);
  const resetFonts = useGitSettings((state) => state.resetFonts);

  const customized = Boolean(interfaceFontFamily || codeFontFamily);

  return (
    <SettingCard
      title={t("gitRepo.extras.fonts.title")}
      description={t("gitRepo.extras.fonts.description")}
      action={
        customized ? (
          <Button variant="ghost" size="sm" onClick={resetFonts}>
            {t("gitRepo.extras.fonts.reset")}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={t("gitRepo.extras.fonts.interface")}
          hint={t("gitRepo.extras.fonts.interfaceHint")}
        >
          <FontSelect
            value={interfaceFontFamily}
            onChange={setInterfaceFontFamily}
            fonts={fonts}
            loading={loading}
            monospaceFirst={false}
            defaultFamily={INTERFACE_FONT_DEFAULT}
            defaultLabel={t("gitRepo.extras.fonts.interfaceDefault")}
            ariaLabel={t("gitRepo.extras.fonts.interfaceAria")}
            stackFor={(family) => interfaceFontStack(family)}
          />
        </Field>
        <Field label={t("gitRepo.extras.fonts.code")} hint={t("gitRepo.extras.fonts.codeHint")}>
          <FontSelect
            value={codeFontFamily}
            onChange={setCodeFontFamily}
            fonts={fonts}
            loading={loading}
            monospaceFirst
            defaultFamily={CODE_FONT_DEFAULT}
            defaultLabel={t("gitRepo.extras.fonts.codeDefault")}
            ariaLabel={t("gitRepo.extras.fonts.codeAria")}
            stackFor={(family) => monoFontStack(family)}
          />
          <div
            className={cn("border-border bg-muted/40 mt-1 rounded-md border px-3 py-2 text-xs")}
            style={{ fontFamily: monoFontStack(codeFontFamily) }}
          >
            {PREVIEW}
          </div>
        </Field>
      </div>
    </SettingCard>
  );
}
