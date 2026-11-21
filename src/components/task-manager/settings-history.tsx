// Recorded-history usage and the clear action for the task manager settings
// partition.

import { useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { HistoryUsage } from "@/commands";
import { formatBytes } from "@/components/task-manager/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";

type SettingsHistoryProps = {
  usage: HistoryUsage | null;
  loading: boolean;
  failed: boolean;
  disabled: boolean;
  onRetry: () => void;
  onClear: () => Promise<void>;
};

/** Shows what the history takes on disk; clearing always asks first. */
export function SettingsHistory({
  usage,
  loading,
  failed,
  disabled,
  onRetry,
  onClear,
}: SettingsHistoryProps) {
  const { t, language } = useAppTranslation();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const empty = usage !== null && usage.bytes === 0;
  const canClear = usage !== null && usage.bytes > 0 && !disabled && !clearing;

  const clear = async () => {
    setConfirming(false);
    setClearing(true);
    try {
      await onClear();
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">{t("taskManager.settings.history.title")}</h3>

      <div className="border-border flex items-start justify-between gap-4 rounded-lg border px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{t("taskManager.settings.history.usage")}</p>
          {loading ? (
            <Skeleton className="h-4 w-40" />
          ) : failed || usage === null ? (
            <span className="text-muted-foreground text-xs">
              {t("taskManager.settings.history.loadFailed")}
            </span>
          ) : empty ? (
            <p className="text-muted-foreground text-xs">
              {t("taskManager.settings.history.empty")}
            </p>
          ) : (
            <div className="text-muted-foreground space-y-0.5 text-xs">
              <p>{t("taskManager.settings.history.size", { size: formatBytes(usage.bytes) })}</p>
              {usage.first !== null && (
                <p>
                  {t("taskManager.settings.history.first", {
                    time: new Date(usage.first).toLocaleString(language),
                  })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {failed && (
            <Button variant="outline" size="sm" disabled={disabled} onClick={onRetry}>
              <RefreshCw />
              {t("taskManager.settings.retry")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!canClear}
            onClick={() => setConfirming(true)}
          >
            {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t("taskManager.settings.history.clear")}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("taskManager.settings.history.clearTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {t("taskManager.settings.history.clearBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("taskManager.actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => void clear()}
            >
              {t("taskManager.settings.history.clearAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
