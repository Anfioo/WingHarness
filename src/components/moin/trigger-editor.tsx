// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useState } from "react";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { MoinTrigger } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const TRIGGER_TYPES: { value: MoinTrigger["type"]; labelKey: string }[] = [
  { value: "extension", labelKey: "moin.trigger.extension" },
  { value: "size", labelKey: "moin.trigger.size" },
  { value: "url-pattern", labelKey: "moin.trigger.urlPattern" },
  { value: "name-pattern", labelKey: "moin.trigger.namePattern" },
];

/** A rule of the given kind with no values yet. */
export function emptyTrigger(type: MoinTrigger["type"]): MoinTrigger {
  switch (type) {
    case "extension":
      return { type, exts: [] };
    case "size":
      return { type, min: null, max: null };
    case "url-pattern":
      return { type, patterns: [] };
    case "name-pattern":
      return { type, patterns: [] };
  }
}

/**
 * Splits the comma separated field into extensions: the leading dot is dropped,
 * everything is lowercased and duplicates collapse. `zip, .ZIP` becomes `zip`.
 */
export function parseExtensions(value: string): string[] {
  const exts = new Set<string>();
  for (const entry of value.split(",")) {
    const ext = entry.trim().replace(/^\.+/, "").toLowerCase();
    if (ext) exts.add(ext);
  }
  return [...exts];
}

/** One glob per line; blank lines are dropped. `*` and `?` are the only wildcards. */
export function parsePatterns(value: string): string[] {
  const patterns = new Set<string>();
  for (const entry of value.split("\n")) {
    const pattern = entry.trim();
    if (pattern) patterns.add(pattern);
  }
  return [...patterns];
}

function parseSize(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

export type TriggerEditorProps = {
  trigger: MoinTrigger;
  disabled?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onChange: (trigger: MoinTrigger) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: () => void;
};

/**
 * One rule row: the kind selector plus the inputs that kind needs.
 *
 * The text fields keep their raw value locally — normalising on every keystroke
 * would eat the comma or the newline the user just typed — and push the parsed
 * value up. Remounting on a kind change (the caller keys the row by kind)
 * resets them, so text typed for one kind never leaks into another.
 */
export function TriggerEditor({
  trigger,
  disabled = false,
  canMoveUp = false,
  canMoveDown = false,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: TriggerEditorProps) {
  const { t } = useAppTranslation();
  const [extensionText, setExtensionText] = useState(
    trigger.type === "extension" ? trigger.exts.join(", ") : ""
  );
  const [patternText, setPatternText] = useState(
    trigger.type === "url-pattern" || trigger.type === "name-pattern"
      ? trigger.patterns.join("\n")
      : ""
  );

  const rangeInvalid =
    trigger.type === "size" &&
    trigger.min !== null &&
    trigger.max !== null &&
    trigger.min > trigger.max;

  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-lg border p-2",
        rangeInvalid && "border-destructive/60",
        disabled && "opacity-60"
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Select
          value={trigger.type}
          disabled={disabled}
          onValueChange={(value) => onChange(emptyTrigger(value as MoinTrigger["type"]))}
        >
          <SelectTrigger
            size="sm"
            className="w-36 shrink-0"
            aria-label={t("moin.category.triggers")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRIGGER_TYPES.map(({ value, labelKey }) => (
              <SelectItem key={value} value={value}>
                {t(labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {trigger.type === "extension" && (
          <Input
            className="h-8 min-w-0 flex-1"
            value={extensionText}
            placeholder="zip, pdf, mp4"
            disabled={disabled}
            onChange={(event) => {
              setExtensionText(event.target.value);
              onChange({ type: "extension", exts: parseExtensions(event.target.value) });
            }}
          />
        )}

        {trigger.type === "size" && (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Input
              className="h-8 min-w-0 flex-1"
              type="number"
              min={0}
              step={1}
              value={trigger.min ?? ""}
              placeholder={t("moin.trigger.min")}
              aria-label={t("moin.trigger.min")}
              disabled={disabled}
              onChange={(event) =>
                onChange({ type: "size", min: parseSize(event.target.value), max: trigger.max })
              }
            />
            <span className="text-muted-foreground shrink-0 text-xs">–</span>
            <Input
              className="h-8 min-w-0 flex-1"
              type="number"
              min={0}
              step={1}
              value={trigger.max ?? ""}
              placeholder={t("moin.trigger.max")}
              aria-label={t("moin.trigger.max")}
              disabled={disabled}
              onChange={(event) =>
                onChange({ type: "size", min: trigger.min, max: parseSize(event.target.value) })
              }
            />
          </div>
        )}

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0"
          aria-label={t("moin.category.moveUp")}
          disabled={disabled || !canMoveUp}
          onClick={onMoveUp}
        >
          <ChevronUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t("moin.category.moveDown")}
          disabled={disabled || !canMoveDown}
          onClick={onMoveDown}
        >
          <ChevronDown />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t("moin.trigger.remove")}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      {(trigger.type === "url-pattern" || trigger.type === "name-pattern") && (
        <Textarea
          className="min-h-14 font-mono text-xs"
          rows={2}
          value={patternText}
          placeholder={trigger.type === "url-pattern" ? "https://example.com/*" : "*.zip"}
          disabled={disabled}
          aria-label={t(
            trigger.type === "url-pattern" ? "moin.trigger.urlPattern" : "moin.trigger.namePattern"
          )}
          onChange={(event) => {
            setPatternText(event.target.value);
            onChange({ type: trigger.type, patterns: parsePatterns(event.target.value) });
          }}
        />
      )}

      {rangeInvalid && (
        <p role="alert" className="text-destructive text-xs">
          {t("moin.trigger.invalidRange")}
        </p>
      )}
    </div>
  );
}
