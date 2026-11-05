import { createElement, useMemo, useState } from "react";
import { ChevronDown, FolderOpen, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { sidebarIconsOpenDir } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CcSwitchLogo } from "@/components/icons/cc-switch-logo";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useCustomIcons } from "@/hooks/use-custom-icons";
import type { AppRouteIcon } from "@/lib/app-routes";
import {
  CUSTOM_ICON_PREFIX,
  ICON_CATALOG,
  customIconName,
  resolveIcon,
  type IconOption,
} from "@/lib/icon-set";
import { cn } from "@/lib/utils";

function matches(option: IconOption, needle: string) {
  return (
    option.name.toLowerCase().includes(needle) || option.keywords.toLowerCase().includes(needle)
  );
}

/** Colours the picker offers as one-click swatches; the input covers the rest. */
const ICON_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#64748b",
];

/** The name shown for a stored value: the file stem for a custom icon. */
function labelOf(value: string) {
  return customIconName(value) ?? value;
}

/**
 * Picks the icon a sidebar entry is drawn with, and its colour.
 *
 * The catalog is scanned rather than paginated: it is small enough that the
 * search box is optional, and a grid beats a dropdown of names. Custom SVGs are
 * read from the app's icons folder, so the picker also carries a way to open it
 * and to re-read it after a file was added.
 */
export function IconPicker({
  value,
  color,
  onChange,
  onColorChange,
  fallback: Fallback,
}: {
  /** Catalog name or `custom:<stem>`, or `null` for the entry's own icon. */
  value: string | null;
  /** CSS colour, or `null` for the theme's own. */
  color: string | null;
  onChange: (name: string | null) => void;
  onColorChange: (color: string | null) => void;
  /** Drawn while nothing is chosen, so the trigger shows the current look. */
  fallback: AppRouteIcon;
}) {
  const { t } = useAppTranslation();
  const { icons: customIcons, byName: customByName, dir, refreshAll } = useCustomIcons();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();

  const builtin = useMemo(
    () => (needle ? ICON_CATALOG.filter((option) => matches(option, needle)) : ICON_CATALOG),
    [needle]
  );

  const custom = useMemo(() => {
    const options: IconOption[] = customIcons.map((entry) => ({
      name: `${CUSTOM_ICON_PREFIX}${entry.name}`,
      icon: entry.icon,
      keywords: entry.name,
    }));
    return needle ? options.filter((option) => matches(option, needle)) : options;
  }, [customIcons, needle]);

  const Current = resolveIcon(value, customByName) ?? Fallback;
  // A custom SVG is a picture and the CC Switch mark carries its own gradient,
  // so neither changes with the colour control.
  const colorable = customIconName(value) === null && Current !== CcSwitchLogo;

  const pick = (name: string | null) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };

  const openFolder = () => {
    void sidebarIconsOpenDir().catch((error: unknown) => toast.error(String(error)));
  };

  const renderGrid = (options: IconOption[], selected: string | null) => (
    <div className="grid grid-cols-8 gap-1">
      {options.map((option) => {
        const Icon = option.icon;
        const isSelected = option.name === selected;
        return (
          <button
            key={option.name}
            type="button"
            title={labelOf(option.name)}
            aria-label={labelOf(option.name)}
            aria-pressed={isSelected}
            onClick={() => pick(option.name)}
            className={cn(
              "hover:bg-accent hover:text-accent-foreground flex size-8 items-center justify-center rounded-md",
              isSelected && "bg-accent text-accent-foreground ring-ring ring-2"
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Re-read on every open so a file dropped into the folder meanwhile shows
        // up, and tell the other windows too — they draw the entry once it is saved.
        if (next) void refreshAll();
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start gap-2 font-normal">
          {createElement(Current, {
            className: "size-4 shrink-0",
            style: color ? { color } : undefined,
          })}
          <span className="truncate">
            {value ? labelOf(value) : t("sidebarManager.iconDefault")}
          </span>
          <ChevronDown className="ms-auto size-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-80 p-2"
        // The picker opens inside a dialog, whose scroll lock cancels wheel
        // events over portalled content it does not own. Keeping the event in
        // this panel lets the icon grid scroll.
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("sidebarManager.iconSearch")}
          className="mb-2 h-8"
        />

        <div className="max-h-72 space-y-3 overflow-y-auto pe-1">
          {builtin.length > 0 && (
            <section className="space-y-1">
              <p className="text-muted-foreground px-1 text-xs">
                {t("sidebarManager.iconBuiltin")}
              </p>
              {renderGrid(builtin, value)}
            </section>
          )}

          <section className="space-y-1">
            <div className="flex items-center gap-1 px-1">
              <p className="text-muted-foreground me-auto text-xs">
                {t("sidebarManager.iconCustom")}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title={t("sidebarManager.iconOpenFolder")}
                aria-label={t("sidebarManager.iconOpenFolder")}
                onClick={openFolder}
              >
                <FolderOpen />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title={t("sidebarManager.iconRefresh")}
                aria-label={t("sidebarManager.iconRefresh")}
                onClick={() => void refreshAll()}
              >
                <RefreshCw />
              </Button>
            </div>

            {custom.length === 0 ? (
              <p className="text-muted-foreground px-1 py-2 text-xs">
                {needle ? t("sidebarManager.iconEmpty") : t("sidebarManager.iconCustomEmpty")}
              </p>
            ) : (
              renderGrid(custom, value)
            )}

            {dir && (
              <p className="text-muted-foreground/70 truncate px-1 text-[11px]" title={dir}>
                {dir}
              </p>
            )}
          </section>

          {colorable ? (
            <section className="space-y-1.5">
              <p className="text-muted-foreground px-1 text-xs">{t("sidebarManager.iconColor")}</p>
              <div className="flex flex-wrap items-center gap-1 px-1">
                {ICON_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    title={swatch}
                    aria-label={swatch}
                    aria-pressed={color?.toLowerCase() === swatch}
                    onClick={() => onColorChange(swatch)}
                    className={cn(
                      "size-5 rounded-full border border-black/10 transition-transform hover:scale-110",
                      color?.toLowerCase() === swatch && "ring-ring ring-2 ring-offset-1"
                    )}
                    style={{ backgroundColor: swatch }}
                  />
                ))}

                <label
                  className="relative size-5 cursor-pointer overflow-hidden rounded-full border border-black/10"
                  title={t("sidebarManager.iconColor")}
                  style={{
                    background: "conic-gradient(#ef4444,#eab308,#22c55e,#3b82f6,#a855f7,#ef4444)",
                  }}
                >
                  <input
                    type="color"
                    value={color ?? "#64748b"}
                    onChange={(event) => onColorChange(event.target.value)}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                    aria-label={t("sidebarManager.iconColor")}
                  />
                </label>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={t("sidebarManager.iconColorDefault")}
                  aria-label={t("sidebarManager.iconColorDefault")}
                  onClick={() => onColorChange(null)}
                >
                  <RotateCcw />
                </Button>
              </div>
            </section>
          ) : (
            <p className="text-muted-foreground px-1 text-[11px]">
              {t("sidebarManager.iconColorHint")}
            </p>
          )}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start gap-2"
          onClick={() => pick(null)}
        >
          <RotateCcw className="size-4" />
          {t("sidebarManager.iconReset")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
