// The task manager's settings dialog: the sampling interval and a shortcut to
// the privileged service. Global settings (theme, language, updates, shortcuts
// and startup) belong to the app's own settings window, not here.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { argusErrorKey, type ArgusError } from "@/commands";
import { ServiceBadge } from "@/components/task-manager/service-badge";
import { openServicePanel } from "@/components/task-manager/service-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";

/** The intervals the backend accepts, 250–5000 ms, in ms. */
const INTERVALS = [250, 500, 1000, 2000, 5000];
const DEFAULT_INTERVAL = 1000;

type TaskManagerSettingsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Let the shared store commit an action's result before reading it back. */
function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export function TaskManagerSettings({ open, onOpenChange }: TaskManagerSettingsProps) {
  const { t } = useAppTranslation();
  const page = useTaskManager();

  const [selected, setSelected] = useState(DEFAULT_INTERVAL);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ArgusError | null>(null);

  // The hook records a failed action in the shared error instead of rejecting,
  // so the newest value is read after the state update has landed.
  const errorRef = useRef<ArgusError | null>(null);
  useLayoutEffect(() => {
    errorRef.current = page.error;
  }, [page.error]);

  // Every open starts from the saved interval, so closing the dialog drops an
  // unsaved choice.
  useEffect(() => {
    if (!open) return;
    setSelected(page.settings.intervalMs);
    setFailure(null);
  }, [open, page.settings.intervalMs]);

  // A hand-edited settings file can hold an interval between two presets; show
  // it rather than a group with nothing selected.
  const options = INTERVALS.includes(page.settings.intervalMs)
    ? INTERVALS
    : [...INTERVALS, page.settings.intervalMs].sort((a, b) => a - b);

  const save = async () => {
    if (saving || selected === page.settings.intervalMs) return;
    const previous = errorRef.current;
    setSaving(true);
    setFailure(null);
    await page.setInterval(selected);
    await nextTask();
    const error = errorRef.current;
    if (error && error !== previous) {
      setFailure(error);
      setSaving(false);
      return;
    }
    setSaving(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("taskManager.settings.title")}</DialogTitle>
          <DialogDescription>{t("taskManager.settings.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label id="task-manager-interval-label">
              {t("taskManager.settings.interval.label")}
            </Label>
            <RadioGroup
              aria-labelledby="task-manager-interval-label"
              value={String(selected)}
              onValueChange={(value) => setSelected(Number(value))}
              className="grid gap-2"
            >
              {options.map((ms) => {
                const id = `task-manager-interval-${ms}`;
                return (
                  <div key={ms} className="flex items-center gap-2">
                    <RadioGroupItem value={String(ms)} id={id} />
                    <Label htmlFor={id} className="font-normal">
                      {t("taskManager.settings.interval.option", { ms })}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
            <p className="text-muted-foreground text-xs">
              {t("taskManager.settings.interval.description")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("taskManager.settings.interval.lifecycle")}
            </p>
          </div>

          {failure && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
            >
              {t(argusErrorKey(failure.code))}
            </div>
          )}

          <div className="space-y-1.5 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t("taskManager.service.label")}</span>
              <ServiceBadge service={page.service} />
              <Button
                variant="outline"
                size="xs"
                className="ml-auto"
                onClick={() => openServicePanel()}
              >
                {t("taskManager.settings.service.open")}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {t("taskManager.settings.service.description")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("taskManager.actions.cancel")}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || selected === page.settings.intervalMs}
          >
            {saving && <Loader2 className="animate-spin" />}
            {t("taskManager.settings.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
