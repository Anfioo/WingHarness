import { useEffect, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  MAX_SHORTCUT_MODIFIERS,
  SHORTCUT_KEY_GROUPS,
  SHORTCUT_KEYS,
  SHORTCUT_MODIFIERS,
  formatCombo,
  isModifierKey,
  keyFromEvent,
  modifiersFromEvent,
  parseCombo,
  presetOf,
  presetSpec,
  type ShortcutModifier,
  type ShortcutPresetId,
} from "@/lib/shortcut-spec";
import { cn } from "@/lib/utils";

type Draft =
  | { kind: "preset"; id: ShortcutPresetId }
  | { kind: "custom"; modifiers: ShortcutModifier[]; key: string };

/** What the custom picker starts on: a key the user can change, no modifier. */
const DEFAULT_KEY = "A";

const MODIFIER_LABELS: Record<ShortcutModifier, string> = {
  Ctrl: "Ctrl",
  Shift: "Shift",
  Alt: "Alt",
  Super: "Win",
};

type ShortcutFieldProps = {
  /** A combination (`Ctrl+Shift+A`, `Super+A`) or `preset:<id>`; empty for none. */
  value: string;
  onChange: (value: string) => void;
  /** Presets shown above the custom picker. Omitted means combinations only. */
  presets?: readonly ShortcutPresetId[];
  /** Offer only the presets: some settings cannot store a free combination. */
  presetsOnly?: boolean;
  placeholder?: string;
  className?: string;
};

/**
 * A shortcut setting that can be recorded, clicked together, or picked from a
 * preset.
 *
 * The same control serves shortcuts of both kinds the app has: combinations the
 * OS registers and in-app triggers such as a bare Space, which only a preset can
 * express. It owns no persistence — the caller decides where the string goes.
 */
export function ShortcutField({
  value,
  onChange,
  presets = [],
  presetsOnly = false,
  placeholder,
  className,
}: ShortcutFieldProps) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFromValue(value));

  const presetLabel = (id: ShortcutPresetId) => t(`shortcutField.presets.${id}`);

  const keyLabel = (key: string) => {
    if (!SHORTCUT_KEYS.has(key)) return key;
    switch (key) {
      case "Space":
        return t("shortcutField.keys.space");
      case "Enter":
        return t("shortcutField.keys.enter");
      case "Tab":
        return t("shortcutField.keys.tab");
      case "Esc":
        return t("shortcutField.keys.escape");
      case "Backspace":
        return t("shortcutField.keys.backspace");
      case "Delete":
        return t("shortcutField.keys.delete");
      case "Insert":
        return t("shortcutField.keys.insert");
      case "Up":
        return t("shortcutField.keys.up");
      case "Down":
        return t("shortcutField.keys.down");
      case "Left":
        return t("shortcutField.keys.left");
      case "Right":
        return t("shortcutField.keys.right");
      case "Home":
        return t("shortcutField.keys.home");
      case "End":
        return t("shortcutField.keys.end");
      case "PageUp":
        return t("shortcutField.keys.pageUp");
      case "PageDown":
        return t("shortcutField.keys.pageDown");
      default:
        return key;
    }
  };

  /** The field's own display: preset name, or the combination's key caps. */
  const display = () => {
    const preset = presetOf(value);
    if (preset) return [{ label: presetLabel(preset), text: true }];
    const combo = parseCombo(value);
    if (!combo) return null;
    return [
      ...combo.modifiers.map((modifier) => ({
        label: MODIFIER_LABELS[modifier],
        text: false,
      })),
      { label: keyLabel(combo.key), text: false },
    ];
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setDraft(draftFromValue(value));
      setRecording(false);
    } else {
      setRecording(false);
    }
  };

  const toggleModifier = (modifier: ShortcutModifier) => {
    setDraft((current) => {
      const custom: { modifiers: ShortcutModifier[]; key: string } =
        current.kind === "custom" ? current : { modifiers: [], key: DEFAULT_KEY };
      if (custom.modifiers.includes(modifier)) {
        return {
          kind: "custom",
          modifiers: custom.modifiers.filter((one) => one !== modifier),
          key: custom.key,
        };
      }
      if (custom.modifiers.length >= MAX_SHORTCUT_MODIFIERS) return current;
      return { kind: "custom", modifiers: [...custom.modifiers, modifier], key: custom.key };
    });
  };

  const setKey = (key: string) => {
    setDraft((current) => ({
      kind: "custom",
      modifiers: current.kind === "custom" ? current.modifiers : [],
      key,
    }));
  };

  // Recording listens on the window so the keystroke is read before anything in
  // the window acts on it; the listener only exists while the button is on.
  useEffect(() => {
    if (!recording) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setRecording(false);
        return;
      }
      if (isModifierKey(event.key)) {
        event.preventDefault();
        setDraft((current) => ({
          kind: "custom",
          modifiers: modifiersFromEvent(event),
          key: current.kind === "custom" ? current.key : DEFAULT_KEY,
        }));
        return;
      }
      const key = keyFromEvent(event);
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      const modifiers = modifiersFromEvent(event).slice(0, MAX_SHORTCUT_MODIFIERS);
      setDraft({ kind: "custom", modifiers, key });
      setRecording(false);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording]);

  const draftSpec =
    draft.kind === "preset" ? presetSpec(draft.id) : formatCombo(draft.modifiers, draft.key);
  const canApply = draftSpec !== "";

  const apply = () => {
    if (!canApply) return;
    onChange(draftSpec);
    setOpen(false);
  };

  const parts = display();

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "border-input bg-background hover:bg-accent flex h-9 min-w-40 items-center justify-center gap-1 rounded-md border px-2 text-sm select-none",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            )}
          >
            {parts ? (
              parts.map((part, index) =>
                part.text ? (
                  <span key={index} className="font-medium">
                    {part.label}
                  </span>
                ) : (
                  <kbd
                    key={index}
                    className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px] font-medium"
                  >
                    {part.label}
                  </kbd>
                )
              )
            ) : (
              <span className="text-muted-foreground">
                {placeholder ?? t("shortcutField.placeholder")}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 space-y-3 p-3">
          {presets.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs font-medium">
                {t("shortcutField.presetsTitle")}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {presets.map((id) => {
                  // Compared by stored form, so a preset that is also a plain
                  // combination is highlighted when the draft spells it out.
                  const selected = draftSpec === presetSpec(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setDraft({ kind: "preset", id })}
                      className={cn(
                        "border-border hover:bg-accent rounded-md border px-2 py-1.5 text-xs transition-colors",
                        selected && "border-primary bg-accent font-medium"
                      )}
                    >
                      {presetLabel(id)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {!presetsOnly && (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs font-medium">
                {t("shortcutField.customTitle")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SHORTCUT_MODIFIERS.map((modifier) => {
                  const active = draft.kind === "custom" && draft.modifiers.includes(modifier);
                  const disabled =
                    draft.kind === "custom" &&
                    !active &&
                    draft.modifiers.length >= MAX_SHORTCUT_MODIFIERS;
                  return (
                    <button
                      key={modifier}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleModifier(modifier)}
                      className={cn(
                        "border-border hover:bg-accent rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40",
                        active && "border-primary bg-accent font-medium"
                      )}
                    >
                      {MODIFIER_LABELS[modifier]}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <Select
                  value={draft.kind === "custom" ? draft.key : DEFAULT_KEY}
                  onValueChange={setKey}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={t("shortcutField.customTitle")}
                    className="bg-background text-foreground h-8 flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {draft.kind === "custom" && !SHORTCUT_KEYS.has(draft.key) && (
                      <SelectItem value={draft.key}>{keyLabel(draft.key)}</SelectItem>
                    )}
                    {SHORTCUT_KEY_GROUPS.map((group) => (
                      <SelectGroup key={group.id}>
                        <SelectLabel>{t(`shortcutField.groups.${group.id}`)}</SelectLabel>
                        {group.keys.map((key) => (
                          <SelectItem key={key} value={key}>
                            {keyLabel(key)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={() => setRecording((current) => !current)}
                  className={cn(
                    "border-border hover:bg-accent flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
                    recording && "border-primary bg-accent"
                  )}
                >
                  <Keyboard className="size-3.5" />
                  {recording ? t("shortcutField.recording") : t("shortcutField.record")}
                </button>
              </div>
              {recording && (
                <p className="text-muted-foreground text-xs">{t("shortcutField.recordHint")}</p>
              )}
              <div className="bg-muted/50 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs">
                <span className="text-muted-foreground">{t("shortcutField.preview")}</span>
                {draftSpec ? (
                  draft.kind === "preset" ? (
                    <span className="font-medium">{presetLabel(draft.id)}</span>
                  ) : (
                    <>
                      {draft.modifiers.map((modifier) => (
                        <kbd key={modifier} className="bg-background rounded px-1 text-[11px]">
                          {MODIFIER_LABELS[modifier]}
                        </kbd>
                      ))}
                      <kbd className="bg-background rounded px-1 text-[11px]">
                        {keyLabel(draft.key)}
                      </kbd>
                    </>
                  )
                ) : (
                  <span>{t("shortcutField.incomplete")}</span>
                )}
              </div>
            </div>
          )}

          <div
            className={cn(
              "flex items-center gap-2 pt-0.5",
              presetsOnly ? "justify-end" : "justify-between"
            )}
          >
            {!presetsOnly && (
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                {t("shortcutField.clear")}
              </button>
            )}
            <button
              type="button"
              disabled={!canApply}
              onClick={apply}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            >
              {t("shortcutField.apply")}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {value && !presetsOnly && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("shortcutField.clear")}
          className="text-muted-foreground hover:text-foreground flex-shrink-0"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function draftFromValue(value: string): Draft {
  const preset = presetOf(value);
  if (preset) return { kind: "preset", id: preset };
  const combo = parseCombo(value);
  return {
    kind: "custom",
    modifiers: combo?.modifiers ?? [],
    key: combo?.key ?? DEFAULT_KEY,
  };
}
