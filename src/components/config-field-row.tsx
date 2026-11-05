import { useAppTranslation } from "@/hooks/use-app-translation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PluginConfigField } from "@/commands";

/**
 * Stands in for an empty option value on the wire to Radix.
 *
 * A manifest may declare an option with an empty value to mean "not set", but
 * Radix refuses `""` as a `Select.Item` value: it renders the items even while
 * the menu is closed (to collect them), so an empty one throws during render.
 * In the frameless, transparent window the plugin config lives in, an unmounted
 * tree just looks like a window that opens and vanishes — no message, no clue.
 * The sentinel keeps the empty state expressible without ever handing Radix one.
 */
const UNSET_OPTION = "__plugin-config-unset__";

/** The value Radix is given for a field's current value. */
function toRadix(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text === "" ? UNSET_OPTION : text;
}

/** The value a manifest means by whatever Radix handed back. */
function fromRadix(value: string): string {
  return value === UNSET_OPTION ? "" : value;
}

/** One declared setting, rendered according to the type its manifest asked for. */
export function ConfigFieldRow({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">{field.label || field.key}</div>
      {field.hint && <div className="text-muted-foreground text-xs">{field.hint}</div>}
      <ConfigFieldInput field={field} value={value} onChange={onChange} />
    </div>
  );
}

function ConfigFieldInput({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useAppTranslation();

  // A `boolean` with options is a two-state toggle: the two options are its
  // states, and `trueValue` names the one that means "on". The button shows the
  // current state's label and fills in when it is the on one, and hands back the
  // literal stored in the file (the option's `value`), never a translated bool.
  // The loader guarantees `trueValue` is set and matches an option, so there is
  // nothing to guess here.
  if (field.type === "boolean" && field.options.length > 0) {
    const isOn = value === field.trueValue;
    const off = field.options.find((option) => option.value !== field.trueValue);
    const shown = field.options.find((option) => option.value === value);
    return (
      <Button
        variant={isOn ? "default" : "outline"}
        size="sm"
        onClick={() => onChange(isOn ? off?.value : field.trueValue)}
      >
        {shown ? shown.label || shown.value : String(value ?? "")}
      </Button>
    );
  }

  // Any other field with options is a dropdown: a `select`'s list of N choices.
  // The dropdown hands back the option's literal text, which is exactly what the
  // write path stores.
  if (field.options.length > 0) {
    return (
      <Select value={toRadix(value)} onValueChange={(next) => onChange(fromRadix(next))}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option) => (
            <SelectItem
              key={option.value === "" ? UNSET_OPTION : option.value}
              value={option.value === "" ? UNSET_OPTION : option.value}
            >
              {/* An option with no label of its own still needs something to
                  show; a dash reads as "nothing set" in any language. */}
              {option.label || option.value || "—"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  switch (field.type) {
    case "boolean":
      return (
        <Button variant={value ? "default" : "outline"} size="sm" onClick={() => onChange(!value)}>
          {value ? t("plugins.valueOn") : t("plugins.valueOff")}
        </Button>
      );

    case "number":
      return (
        <Input
          type="number"
          value={typeof value === "number" ? value : ""}
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          onChange={(event) =>
            onChange(event.target.value === "" ? null : Number(event.target.value))
          }
        />
      );

    case "select":
      // A select is a choice, so it always has options and was handled above.
      // Reaching here means a manifest declared one with no options at all:
      // render it as free text rather than an empty dropdown.
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case "textarea":
      return (
        <Textarea
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    default:
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
