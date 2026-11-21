// The task manager partition of the Settings window.
//
// Every control saves at once and the backend broadcasts the change, so the
// page, the tray row and this window stay in step without a save button. The
// partition never mounts the page hook, which would start a sampling thread.

import { RefreshCw } from "lucide-react";
import { SettingsBackground } from "@/components/task-manager/settings-background";
import { SettingsHistory } from "@/components/task-manager/settings-history";
import { SettingsInterval } from "@/components/task-manager/settings-interval";
import { SettingsService } from "@/components/task-manager/settings-service";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManagerSettings } from "@/hooks/use-task-manager-settings";

export function TaskManagerSection() {
  const { t } = useAppTranslation();
  const controller = useTaskManagerSettings();

  if (controller.loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold">{t("taskManager.settings.title")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("taskManager.settings.description")}
          </p>
        </div>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (controller.loadFailed || !controller.settings) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t("taskManager.settings.title")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("taskManager.settings.description")}
          </p>
        </div>
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">{t("taskManager.error.internal")}</span>
          <Button variant="outline" size="sm" onClick={controller.reload}>
            <RefreshCw />
            {t("taskManager.service.actions.recheck")}
          </Button>
        </div>
      </div>
    );
  }

  const { settings } = controller;
  const saving = controller.saving;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("taskManager.settings.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("taskManager.settings.description")}
        </p>
      </div>

      <SettingsInterval
        intervalMs={settings.intervalMs}
        disabled={saving}
        onChange={(intervalMs) => void controller.saveInterval(intervalMs)}
      />

      <SettingsBackground
        enabled={settings.backgroundMonitoring}
        intervalMs={settings.backgroundIntervalMs}
        disabled={saving}
        onToggle={(enabled) => void controller.setBackgroundMonitoring(enabled)}
        onIntervalChange={(intervalMs) => void controller.saveBackgroundInterval(intervalMs)}
      />

      <SettingsHistory
        usage={controller.usage}
        loading={controller.usageLoading}
        failed={controller.usageFailed}
        disabled={saving}
        onRetry={controller.reloadUsage}
        onClear={controller.clearHistory}
      />

      <SettingsService
        service={controller.service}
        busy={controller.busyService}
        onRefresh={() => void controller.refreshService()}
        onInstall={() => void controller.installService()}
        onUninstall={() => void controller.uninstallService()}
        onUpdate={() => void controller.updateService()}
      />
    </div>
  );
}
