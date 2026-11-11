// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, X } from "lucide-react";
import type { MoinAddMethod, MoinCategory, MoinTrigger } from "@/commands";
import {
  CATEGORY_COLORS,
  CATEGORY_ICON_IDS,
  CategoryGlyph,
  DEFAULT_CATEGORY_COLOR,
  categoryIcon,
} from "@/components/moin/category-card";
import { TriggerEditor, emptyTrigger } from "@/components/moin/trigger-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const SOURCES: MoinAddMethod[] = ["manual-link", "browser-capture"];

/** Absolute on Windows (`C:\dir`, `C:/dir`) or on Unix (`/dir`). */
function isAbsoluteDir(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/)/.test(value.trim());
}

/** New categories go last; the backend renumbers to 10/20/30… on save. */
function nextOrder(categories: MoinCategory[]): number {
  return categories.reduce((max, category) => Math.max(max, category.order), 0) + 10;
}

/** A rule with no values would never match, so it is dropped on save. */
function isMeaningfulTrigger(trigger: MoinTrigger): boolean {
  switch (trigger.type) {
    case "extension":
      return trigger.exts.length > 0;
    case "size":
      return trigger.min !== null || trigger.max !== null;
    case "url-pattern":
    case "name-pattern":
      return trigger.patterns.length > 0;
  }
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5 text-sm">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="font-medium">
          {label}
        </label>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      {children}
      {hint}
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-primary size-4"
      />
      {label}
    </label>
  );
}

export type CategoryEditorProps = {
  open: boolean;
  /** `null` creates a new category. */
  category: MoinCategory | null;
  /** The current list, used for the case-insensitive uniqueness check. */
  categories: MoinCategory[];
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (category: MoinCategory) => void;
};

/**
 * Create / edit drawer for one category.
 *
 * The form owns every field of `MoinCategory` except the unknown keys a future
 * BitTorrent port may store, which are carried over from the edited record. No
 * automation field from the upstream BitTorrent era is exposed here.
 */
export function CategoryEditor({
  open,
  category,
  categories,
  saving,
  onOpenChange,
  onSubmit,
}: CategoryEditorProps) {
  const { t } = useAppTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_CATEGORY_COLOR);
  const [icon, setIcon] = useState<string | null>(null);
  const [saveDir, setSaveDir] = useState("");
  const [incompleteDir, setIncompleteDir] = useState("");
  const [priority, setPriority] = useState("10");
  const [hiddenFromAll, setHiddenFromAll] = useState(false);
  const [sources, setSources] = useState<MoinAddMethod[]>([]);
  const [triggers, setTriggers] = useState<MoinTrigger[]>([]);

  // Reopening the drawer always starts from the record being edited (or from
  // the defaults for a new one); nothing typed last time survives.
  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? "");
    setColor(category?.color || DEFAULT_CATEGORY_COLOR);
    setIcon(category?.icon ?? null);
    setSaveDir(category?.save_dir ?? "");
    setIncompleteDir(category?.incomplete_dir ?? "");
    setPriority(String(category?.order ?? nextOrder(categories)));
    setHiddenFromAll(category?.hidden_from_all ?? false);
    setSources(category?.sources ?? []);
    setTriggers(category?.triggers ?? []);
  }, [open, category, categories]);

  const trimmedName = name.trim();
  const duplicateName = categories.some(
    (item) =>
      item.id !== category?.id && item.name.trim().toLowerCase() === trimmedName.toLowerCase()
  );
  const saveDirInvalid = saveDir.trim() !== "" && !isAbsoluteDir(saveDir);
  const incompleteDirInvalid = incompleteDir.trim() !== "" && !isAbsoluteDir(incompleteDir);
  const rangeInvalid = triggers.some(
    (trigger) =>
      trigger.type === "size" &&
      trigger.min !== null &&
      trigger.max !== null &&
      trigger.min > trigger.max
  );
  const canSave =
    trimmedName !== "" &&
    !duplicateName &&
    !saveDirInvalid &&
    !incompleteDirInvalid &&
    !rangeInvalid &&
    !saving;

  const browse = async (apply: (path: string) => void) => {
    const picked = await pickDirectory({ directory: true, multiple: false });
    if (typeof picked === "string") apply(picked);
  };

  const toggleSource = (source: MoinAddMethod, enabled: boolean) => {
    setSources((current) =>
      enabled ? [...new Set([...current, source])] : current.filter((entry) => entry !== source)
    );
  };

  const replaceTrigger = (index: number, next: MoinTrigger) => {
    setTriggers((current) =>
      current.map((trigger, position) => (position === index ? next : trigger))
    );
  };

  // Rules are AND-ed, so their order is cosmetic — but the list is the user's,
  // and moving a rule is cheaper than retyping it.
  const moveTrigger = (index: number, direction: -1 | 1) => {
    setTriggers((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (!moved) return next;
      next.splice(target, 0, moved);
      return next;
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    // An empty or half-typed priority falls back to the end of the list.
    const order = priority.trim() === "" ? Number.NaN : Number(priority);
    const next: MoinCategory = {
      ...(category ?? {}),
      id: category?.id ?? crypto.randomUUID(),
      name: trimmedName,
      color,
      icon,
      hidden_from_all: hiddenFromAll,
      save_dir: saveDir.trim() || null,
      incomplete_dir: incompleteDir.trim() || null,
      sources,
      triggers: triggers.filter(isMeaningfulTrigger),
      order: Number.isFinite(order) ? Math.trunc(order) : nextOrder(categories),
    };
    onSubmit(next);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader>
            <SheetTitle>
              {t(category ? "moin.category.editTitle" : "moin.category.createTitle")}
            </SheetTitle>
            <SheetDescription>{t("moin.category.subtitle")}</SheetDescription>
          </SheetHeader>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4">
            <Field label={t("moin.category.name")} htmlFor="moin-category-name">
              <Input
                id="moin-category-name"
                value={name}
                maxLength={128}
                autoComplete="off"
                disabled={saving}
                aria-invalid={duplicateName}
                onChange={(event) => setName(event.target.value)}
              />
              {duplicateName && (
                <p role="alert" className="text-destructive text-xs">
                  {t("moin.category.duplicateName")}
                </p>
              )}
            </Field>

            <Field label={t("moin.category.color")}>
              <div className="flex flex-wrap items-center gap-2">
                {!CATEGORY_COLORS.some((entry) => entry.hex === color.toLowerCase()) && (
                  // The seeded and hand-edited colours are plain hex values that
                  // are not in the palette; showing the current one keeps the
                  // field honest instead of silently picking a token.
                  <span
                    aria-hidden
                    title={color}
                    className="ring-ring ring-offset-background size-6 rounded-full ring-2 ring-offset-2"
                    style={{ backgroundColor: color }}
                  />
                )}
                {CATEGORY_COLORS.map((entry) => (
                  <button
                    key={entry.token}
                    type="button"
                    aria-label={`${t("moin.category.color")} ${entry.token}`}
                    aria-pressed={entry.hex === color.toLowerCase()}
                    disabled={saving}
                    onClick={() => setColor(entry.hex)}
                    className={cn(
                      "size-6 rounded-full border",
                      entry.swatch,
                      entry.hex === color.toLowerCase() &&
                        "ring-ring ring-offset-background ring-2 ring-offset-2"
                    )}
                  />
                ))}
              </div>
            </Field>

            <Field label={t("moin.category.icon")}>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  aria-label={t("moin.common.clear")}
                  aria-pressed={icon === null}
                  disabled={saving}
                  onClick={() => setIcon(null)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md border",
                    icon === null && "border-primary ring-ring/40 ring-2"
                  )}
                >
                  <CategoryGlyph icon={null} color={color} className="size-3" />
                </button>
                {CATEGORY_ICON_IDS.map((id) => {
                  const Icon = categoryIcon(id);
                  if (!Icon) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-label={id}
                      aria-pressed={icon === id}
                      disabled={saving}
                      onClick={() => setIcon(id)}
                      className={cn(
                        "flex size-8 items-center justify-center rounded-md border",
                        icon === id && "border-primary ring-ring/40 ring-2"
                      )}
                    >
                      <Icon className="size-4" />
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label={t("moin.category.saveDir")} htmlFor="moin-category-save-dir">
              <div className="flex items-center gap-1.5">
                <Input
                  id="moin-category-save-dir"
                  className="min-w-0 flex-1 font-mono text-xs"
                  value={saveDir}
                  disabled={saving}
                  aria-invalid={saveDirInvalid}
                  onChange={(event) => setSaveDir(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => void browse(setSaveDir)}
                >
                  <FolderOpen />
                  {t("moin.common.browse")}
                </Button>
                {saveDir !== "" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("moin.common.clear")}
                    disabled={saving}
                    onClick={() => setSaveDir("")}
                  >
                    <X />
                  </Button>
                )}
              </div>
              {saveDirInvalid && (
                <p role="alert" className="text-destructive text-xs">
                  {t("moin.category.invalidDir")}
                </p>
              )}
            </Field>

            <Field label={t("moin.category.incompleteDir")} htmlFor="moin-category-incomplete-dir">
              <div className="flex items-center gap-1.5">
                <Input
                  id="moin-category-incomplete-dir"
                  className="min-w-0 flex-1 font-mono text-xs"
                  value={incompleteDir}
                  disabled={saving}
                  aria-invalid={incompleteDirInvalid}
                  onChange={(event) => setIncompleteDir(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => void browse(setIncompleteDir)}
                >
                  <FolderOpen />
                  {t("moin.common.browse")}
                </Button>
                {incompleteDir !== "" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("moin.common.clear")}
                    disabled={saving}
                    onClick={() => setIncompleteDir("")}
                  >
                    <X />
                  </Button>
                )}
              </div>
              {incompleteDirInvalid && (
                <p role="alert" className="text-destructive text-xs">
                  {t("moin.category.invalidDir")}
                </p>
              )}
            </Field>

            <Field label={t("moin.category.order")} htmlFor="moin-category-order">
              <Input
                id="moin-category-order"
                className="w-28"
                type="number"
                step={10}
                value={priority}
                disabled={saving}
                onChange={(event) => setPriority(event.target.value)}
              />
            </Field>

            <div className="flex items-center justify-between gap-3 rounded-lg border p-2.5">
              <span className="text-sm font-medium">{t("moin.category.hiddenFromAll")}</span>
              <Switch
                checked={hiddenFromAll}
                disabled={saving}
                aria-label={t("moin.category.hiddenFromAll")}
                onCheckedChange={setHiddenFromAll}
              />
            </div>

            <Field label={t("moin.category.sources")}>
              <div className="flex flex-wrap gap-4">
                {SOURCES.map((source) => (
                  <Toggle
                    key={source}
                    label={t(`moin.category.source.${source}`)}
                    checked={sources.includes(source)}
                    disabled={saving}
                    onChange={(checked) => toggleSource(source, checked)}
                  />
                ))}
              </div>
            </Field>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t("moin.category.triggers")}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={saving}
                  onClick={() => setTriggers((current) => [...current, emptyTrigger("extension")])}
                >
                  <Plus />
                  {t("moin.trigger.add")}
                </Button>
              </div>
              {triggers.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("moin.category.noRules")}</p>
              ) : (
                triggers.map((trigger, index) => (
                  <TriggerEditor
                    key={`${index}-${trigger.type}`}
                    trigger={trigger}
                    disabled={saving}
                    canMoveUp={index > 0}
                    canMoveDown={index < triggers.length - 1}
                    onChange={(next) => replaceTrigger(index, next)}
                    onMoveUp={() => moveTrigger(index, -1)}
                    onMoveDown={() => moveTrigger(index, 1)}
                    onRemove={() =>
                      setTriggers((current) => current.filter((_, position) => position !== index))
                    }
                  />
                ))
              )}
            </div>
          </div>

          <SheetFooter className="flex-row justify-end gap-2 border-t">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t("moin.common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? t("moin.common.saving") : t("moin.common.save")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
