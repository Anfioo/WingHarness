// The privileged service's status and install, update and uninstall actions in
// the task manager settings partition.

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { ServiceStatus } from "@/commands";
import { ServiceBadge } from "@/components/task-manager/service-badge";
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
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { TaskManagerServiceAction } from "@/hooks/use-task-manager-settings";

type SettingsServiceProps = {
  service: ServiceStatus | null;
  busy: TaskManagerServiceAction | null;
  onRefresh: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  onUpdate: () => void;
};

/**
 * Installing and uninstalling always ask first; the UAC prompt is the second
 * confirmation and nothing here runs on mount.
 */
export function SettingsService({
  service,
  busy,
  onRefresh,
  onInstall,
  onUninstall,
  onUpdate,
}: SettingsServiceProps) {
  const { t } = useAppTranslation();
  const [confirming, setConfirming] = useState<"install" | "uninstall" | null>(null);

  const state = service?.state ?? null;
  const notInstalled = state === "notInstalled";
  const installed = service !== null && !notInstalled;
  const connected = service !== null && state === "running" && service.authorized && !service.error;
  const incompatible = service?.incompatible === true;
  const busyNow = busy !== null;

  return (
    <section className="space-y-3 border-t pt-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{t("taskManager.service.label")}</h3>
        <ServiceBadge service={service} />
      </div>
      <p className="text-muted-foreground text-xs">
        {t("taskManager.settings.service.description")}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busyNow} onClick={onRefresh}>
          {busy === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("taskManager.service.actions.recheck")}
        </Button>
        {notInstalled && (
          <Button size="sm" disabled={busyNow} onClick={() => setConfirming("install")}>
            {busy === "install" && <Loader2 className="animate-spin" />}
            {t("taskManager.service.actions.install")}
          </Button>
        )}
        {installed && (!connected || incompatible) && (
          <Button variant="outline" size="sm" disabled={busyNow} onClick={onUpdate}>
            {busy === "update" && <Loader2 className="animate-spin" />}
            {t("taskManager.service.actions.update")}
          </Button>
        )}
        {installed && (
          <Button
            variant="destructive"
            size="sm"
            disabled={busyNow}
            onClick={() => setConfirming("uninstall")}
          >
            {busy === "uninstall" && <Loader2 className="animate-spin" />}
            {t("taskManager.service.actions.uninstall")}
          </Button>
        )}
      </div>

      <AlertDialog
        open={confirming === "install"}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("taskManager.service.install.title")}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {t("taskManager.service.install.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("taskManager.actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(null);
                onInstall();
              }}
            >
              {t("taskManager.service.install.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirming === "uninstall"}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("taskManager.service.uninstall.title")}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {t("taskManager.service.uninstall.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("taskManager.actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => {
                setConfirming(null);
                onUninstall();
              }}
            >
              {t("taskManager.service.uninstall.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
