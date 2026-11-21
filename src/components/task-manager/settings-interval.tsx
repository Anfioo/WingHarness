// Sampling interval picker for the task manager settings partition.

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/** The intervals the backend accepts, 250–5000 ms, in ms. */
const INTERVALS = [250, 500, 1000, 2000, 5000];

type SettingsIntervalProps = {
  intervalMs: number;
  disabled: boolean;
  onChange: (intervalMs: number) => void;
};

/** A radio group of presets, with a hand-edited value inserted when needed. */
export function SettingsInterval({ intervalMs, disabled, onChange }: SettingsIntervalProps) {
  const { t } = useAppTranslation();

  // A settings file edited by hand can hold a value between two presets; show
  // it rather than a group with nothing selected.
  const options = INTERVALS.includes(intervalMs)
    ? INTERVALS
    : [...INTERVALS, intervalMs].sort((left, right) => left - right);

  return (
    <section className="space-y-2 border-t pt-4">
      <div className="space-y-0.5">
        <h3 id="task-manager-interval-label" className="text-sm font-medium">
          {t("taskManager.settings.interval.label")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("taskManager.settings.interval.description")}
        </p>
      </div>

      <RadioGroup
        aria-labelledby="task-manager-interval-label"
        value={String(intervalMs)}
        onValueChange={(value) => onChange(Number(value))}
        disabled={disabled}
        className="grid gap-2 sm:grid-cols-2"
      >
        {options.map((ms) => {
          const id = `task-manager-interval-${ms}`;
          return (
            <div
              key={ms}
              className={cn(
                "border-border flex items-center gap-2 rounded-lg border px-3 py-2",
                disabled && "opacity-60"
              )}
            >
              <RadioGroupItem value={String(ms)} id={id} />
              <Label htmlFor={id} className="font-normal">
                {t("taskManager.settings.interval.option", { ms })}
              </Label>
            </div>
          );
        })}
      </RadioGroup>

      <p className="text-muted-foreground text-xs">
        {t("taskManager.settings.interval.lifecycle")}
      </p>
    </section>
  );
}
