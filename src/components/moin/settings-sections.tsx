// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useId, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * Form primitives for the settings tab: one titled card, and the label/control
 * rows every field in it is built from.
 *
 * Rows are deliberately split in two columns — label plus hint on the left, the
 * control on the right — so a long hint never pushes the control out of line
 * with its neighbours.
 */

export type SectionProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

/** A titled card grouping related settings. */
export function Section({ title, description, children }: SectionProps) {
  return (
    <section className="bg-card rounded-lg border p-4 sm:p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="text-muted-foreground mt-1 text-xs">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

export type FieldProps = {
  label: string;
  /** Links the label to a control; omit for controls that carry their own aria-label. */
  htmlFor?: string;
  hint?: string;
  /** A second, quieter line — used for "0 means…" style clarifications. */
  note?: string;
  /** Replaces the note while a draft is rejected, so the row keeps one error line. */
  error?: string;
  children: ReactNode;
};

/** One label/control row. */
export function Field({ label, htmlFor, hint, note, error, children }: FieldProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
        {error ? (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        ) : (
          note && <p className="text-muted-foreground text-xs">{note}</p>
        )}
      </div>
      <div className="min-w-0 sm:justify-self-end">{children}</div>
    </div>
  );
}

export type SelectOption = {
  value: string;
  label: string;
  /** Already-translated suffix, shown when the option cannot be picked. */
  badge?: string;
  disabled?: boolean;
};

export type SelectFieldProps = {
  label: string;
  hint?: string;
  note?: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
};

/** A dropdown row; picking an option commits immediately. */
export function SelectField({
  label,
  hint,
  note,
  value,
  options,
  disabled = false,
  onChange,
}: SelectFieldProps) {
  const id = useId();

  return (
    <Field label={label} htmlFor={id} hint={hint} note={note}>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full sm:w-44" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled ?? false}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{option.label}</span>
                {option.badge && (
                  <span className="text-muted-foreground shrink-0 text-xs">{option.badge}</span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export type NumberFieldProps = {
  label: string;
  hint?: string;
  note?: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
};

/**
 * A whole-number row that only commits on blur, so a half-typed value never
 * reaches the backend. An out-of-range draft stays on screen with an inline
 * error and is not submitted; an empty draft is treated as "no change".
 */
export function NumberField({
  label,
  hint,
  note,
  value,
  min,
  max,
  disabled = false,
  onCommit,
}: NumberFieldProps) {
  const { t } = useAppTranslation();
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);

  // Follow the committed value, including a rollback after a rejected patch.
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(String(value));
      setInvalid(false);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <Field
      label={label}
      htmlFor={id}
      hint={hint}
      note={note}
      error={invalid ? t("moin.settings.invalidNumbers") : undefined}
    >
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="w-full sm:w-32"
      />
    </Field>
  );
}

export type SwitchFieldProps = {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

/** An on/off row; flipping it commits immediately. */
export function SwitchField({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: SwitchFieldProps) {
  return (
    <Field label={label} hint={hint}>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </Field>
  );
}
