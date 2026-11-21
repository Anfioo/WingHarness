// Background monitoring switch and frequency for the task manager settings
// partition.

import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** The background frequencies offered, in seconds. */
const BACKGROUND_INTERVALS_SECONDS = [5, 10, 15, 30];

type SettingsBackgroundProps = {
  enabled: boolean;
  intervalMs: number;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onIntervalChange: (intervalMs: number) => void;
};

/**
 * The switch saves at once. The frequency stays visible but disabled while
 * monitoring is off, so the saved value is not lost.
 */
export function SettingsBackground({
  enabled,
  intervalMs,
  disabled,
  onToggle,
  onIntervalChange,
}: SettingsBackgroundProps) {
  const { t } = useAppTranslation();

  const seconds = intervalMs / 1000;
  const options = BACKGROUND_INTERVALS_SECONDS.includes(seconds)
    ? BACKGROUND_INTERVALS_SECONDS
    : [...BACKGROUND_INTERVALS_SECONDS, seconds].sort((left, right) => left - right);

  return (
    <section className="space-y-3 border-t pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h3 id="task-manager-background-label" className="text-sm font-medium">
            {t("taskManager.settings.background.label")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("taskManager.settings.background.description")}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-labelledby="task-manager-background-label"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <h4 className="text-sm font-medium">
            {t("taskManager.settings.background.intervalLabel")}
          </h4>
          <p className="text-muted-foreground text-xs">
            {t("taskManager.settings.background.intervalDescription")}
          </p>
        </div>
        <Select
          value={String(seconds)}
          onValueChange={(value) => onIntervalChange(Number(value) * 1000)}
          disabled={disabled || !enabled}
        >
          <SelectTrigger
            className="w-28"
            aria-label={t("taskManager.settings.background.intervalLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {t("taskManager.settings.background.intervalOption", { seconds: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
