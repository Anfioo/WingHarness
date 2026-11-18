// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The privileged service: a summary row in the page flow and a sheet with the
// service's state and the install, update and uninstall actions. Installing and
// uninstalling always ask first and always go through a UAC prompt; nothing
// here runs on mount.

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { argusErrorKey, type ArgusError, type ServiceStatus } from "@/commands";
import { Button } from "@/components/ui/button";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTaskManager } from "@/hooks/use-task-manager";
import { cn } from "@/lib/utils";
import { ServiceBadge, isKnownServiceState } from "./service-badge";

// The page shell imports the state-key helper from this module, and the badge
// owns it now.
export { serviceStateKey } from "./service-badge";

type ServiceAction = "install" | "uninstall" | "update";

// One open state for the one sheet on the page: the settings dialog is rendered
// next to this panel, not above it, so opening it from there needs a shared
// signal rather than a prop.
let panelOpen = false;
const openListeners = new Set<() => void>();

function setPanelOpen(open: boolean): void {
  if (panelOpen === open) return;
  panelOpen = open;
  for (const listener of openListeners) listener();
}

/** Opens the service sheet from anywhere on the page. */
export function openServicePanel(): void {
  setPanelOpen(true);
}

function subscribePanel(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

function getPanelOpen(): boolean {
  return panelOpen;
}

/** Let the shared store commit an action's result before reading it back. */
function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

/**
 * The privileged service card.
 *
 * The page renders this inline, so the always-visible row keeps the state and
 * the reason the service matters in sight; the sheet holds the details and the
 * actions. `service` comes from the page shell, the actions from the shared
 * store.
 */
export function ServicePanel({ service }: { service: ServiceStatus | null }) {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const isMobile = useIsMobile();
  const open = useSyncExternalStore(subscribePanel, getPanelOpen, getPanelOpen);

  const [confirming, setConfirming] = useState<ServiceAction | null>(null);
  const [busy, setBusy] = useState<ServiceAction | "reload" | null>(null);
  const [failure, setFailure] = useState<ArgusError | null>(null);
  const [cancelled, setCancelled] = useState(false);

  // The hook records a failed action in the shared error instead of rejecting,
  // so the newest value is read after the state update has landed.
  const errorRef = useRef<ArgusError | null>(null);
  useLayoutEffect(() => {
    errorRef.current = page.error;
  }, [page.error]);

  const state = service?.state ?? "notInstalled";
  const notInstalled = service !== null && state === "notInstalled";
  const incompatible = service?.incompatible === true;
  const connected = state === "running" && service?.authorized === true && !service.error;
  const unknownState = service !== null && !isKnownServiceState(state);
  const busyNow = busy !== null;

  const hint =
    service === null
      ? t("taskManager.service.checking")
      : notInstalled
        ? t("taskManager.empty.service")
        : incompatible
          ? t("taskManager.service.incompatibleHint")
          : connected
            ? t("taskManager.service.enabledHint")
            : state === "stopped"
              ? t("taskManager.service.stoppedHint")
              : t("taskManager.service.unavailableHint");

  const runManage = async (action: ServiceAction) => {
    if (busyNow) return;
    const previous = errorRef.current;
    setBusy(action);
    setFailure(null);
    setCancelled(false);
    await (action === "install"
      ? page.installService()
      : action === "uninstall"
        ? page.uninstallService()
        : page.updateService());
    await nextTask();
    const error = errorRef.current;
    if (error?.code === "access-denied") {
      // The UAC prompt was dismissed: nothing changed, so the state is the answer.
      setCancelled(true);
      await page.reloadService();
    } else if (error && error !== previous) {
      setFailure(error);
    }
    setBusy(null);
  };

  const recheck = async () => {
    if (busyNow) return;
    const previous = errorRef.current;
    setBusy("reload");
    setFailure(null);
    setCancelled(false);
    await page.reloadService();
    await nextTask();
    const error = errorRef.current;
    if (error && error !== previous) setFailure(error);
    setBusy(null);
  };

  return (
    <section className="bg-muted/30 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <span className="font-medium">{t("taskManager.service.label")}</span>
      <ServiceBadge service={service} onClick={() => setPanelOpen(true)} />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={hint}>
        {hint}
      </span>
      <Button size="xs" variant="ghost" onClick={() => setPanelOpen(true)}>
        {t("taskManager.service.open")}
        <ChevronRight />
      </Button>

      <Sheet open={open} onOpenChange={setPanelOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn("w-full gap-0", isMobile ? "max-h-[85vh]" : "sm:max-w-md")}
        >
          <SheetHeader>
            <SheetTitle>{t("taskManager.service.label")}</SheetTitle>
            <SheetDescription>{t("taskManager.service.description")}</SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            <div className="space-y-1.5 rounded-lg border px-3 py-2">
              <InfoRow label={t("taskManager.service.details.status")}>
                <ServiceBadge service={service} />
              </InfoRow>
              <InfoRow label={t("taskManager.service.details.version")}>
                <span className="font-mono text-xs">
                  {service?.version ?? t("taskManager.service.unknown")}
                </span>
              </InfoRow>
              {service !== null && !notInstalled && (
                <InfoRow label={t("taskManager.service.details.account")}>
                  {service.authorized
                    ? t("taskManager.service.authorized")
                    : t("taskManager.service.notAuthorized")}
                </InfoRow>
              )}
              {unknownState && (
                <InfoRow label={t("taskManager.service.details.reported")}>
                  <span className="font-mono text-xs">{state}</span>
                </InfoRow>
              )}
            </div>

            <p className="text-muted-foreground text-sm">{hint}</p>

            {service?.error && (
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">
                  {t("taskManager.service.errorDetails")}
                </p>
                <pre className="bg-muted/50 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs break-all whitespace-pre-wrap select-text">
                  {service.error}
                </pre>
              </div>
            )}

            {cancelled && (
              <p role="status" className="text-muted-foreground text-sm">
                {t("taskManager.service.cancelled")}
              </p>
            )}

            {failure && (
              <div
                role="alert"
                className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
              >
                {t(argusErrorKey(failure.code))}
              </div>
            )}

            {busyNow && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" />
                {t("taskManager.service.busy")}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={busyNow} onClick={() => void recheck()}>
                {busy === "reload" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("taskManager.service.actions.recheck")}
              </Button>
              {notInstalled && (
                <Button size="sm" disabled={busyNow} onClick={() => setConfirming("install")}>
                  {t("taskManager.service.actions.install")}
                </Button>
              )}
              {service !== null && !notInstalled && (!connected || incompatible) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyNow}
                  onClick={() => void runManage("update")}
                >
                  {busy === "update" && <Loader2 className="animate-spin" />}
                  {t("taskManager.service.actions.update")}
                </Button>
              )}
              {service !== null && !notInstalled && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busyNow}
                  onClick={() => setConfirming("uninstall")}
                >
                  {t("taskManager.service.actions.uninstall")}
                </Button>
              )}
            </div>
          </div>

          <SheetFooter>
            <Button variant="outline" onClick={() => setPanelOpen(false)}>
              {t("taskManager.actions.close")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={confirming === "install"}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
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
            <AlertDialogAction onClick={() => void runManage("install")}>
              {t("taskManager.service.install.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirming === "uninstall"}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
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
              onClick={() => void runManage("uninstall")}
            >
              {t("taskManager.service.uninstall.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
