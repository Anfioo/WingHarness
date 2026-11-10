import { memo, type KeyboardEvent } from "react";
import { Pin, PinOff, X } from "lucide-react";
import type { PortStatus } from "@/commands";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { portService } from "@/lib/ports/port-services";
import { cn } from "@/lib/utils";
import type { PortRowProps } from "./props";

const STATUS_DOT: Record<PortStatus, string> = {
  free: "bg-emerald-500",
  occupied: "bg-amber-500",
  system: "bg-muted-foreground/50",
};

const STATUS_BADGE: Record<PortStatus, string> = {
  free: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  occupied: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  system: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color,color] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none active:scale-90";

export const PortRow = memo(function PortRow({
  port,
  pinned,
  showPin,
  onOpenDetail,
  onKill,
  onTogglePin,
}: PortRowProps) {
  const { t } = useAppTranslation();
  const portProcess = port.process;
  const service = portService(port.port);
  const ServiceIcon = service.icon;
  const statusLabel = t(`ports.status.${port.status}`);

  const openDetail = () => onOpenDetail(port.port);

  // Enter and Space open the detail only when the row itself has focus; a
  // nested button handling its own key press must not also open the detail.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openDetail();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openDetail}
      onKeyDown={handleKeyDown}
      className="group hover:bg-accent focus-visible:ring-ring/50 flex h-12 cursor-pointer items-center gap-3 px-3.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      {/* Status dot */}
      <span className="relative flex size-2 shrink-0 items-center justify-center">
        {port.status === "occupied" && (
          <span
            className={cn(
              "absolute inset-0 rounded-full opacity-40 blur-[3px]",
              STATUS_DOT.occupied
            )}
          />
        )}
        <span className={cn("relative size-1.5 rounded-full", STATUS_DOT[port.status])} />
      </span>

      {/* Port number */}
      <span className="w-[52px] shrink-0 font-mono text-sm font-medium tabular-nums">
        {port.port}
      </span>

      {/* Service name and icon */}
      <div className="text-muted-foreground flex w-[118px] shrink-0 items-center gap-1.5">
        <ServiceIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="truncate text-xs">{service.label ?? t("ports.list.unknownService")}</span>
        {pinned && showPin && (
          <Pin aria-hidden className="size-3 shrink-0 rotate-45 fill-current" />
        )}
      </div>

      {/* Process name and PID */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {portProcess !== null ? (
          <>
            <span className="text-foreground truncate text-xs font-medium">{portProcess.name}</span>
            <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
              {portProcess.pid}
            </span>
          </>
        ) : (
          <>
            <span className="text-muted-foreground text-xs">—</span>
            <Badge variant="outline" className="text-muted-foreground shrink-0">
              {t("ports.list.notRunning")}
            </Badge>
          </>
        )}
      </div>

      {/* Status badge */}
      <Badge variant="outline" className={cn("shrink-0", STATUS_BADGE[port.status])}>
        {statusLabel}
      </Badge>

      {/* Pin */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(port.port);
        }}
        aria-label={t(pinned ? "ports.row.unpinAria" : "ports.row.pinAria", { port: port.port })}
        aria-pressed={pinned}
        className={cn(
          ICON_BUTTON,
          "hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2"
        )}
      >
        {pinned ? (
          <PinOff className="size-3.5" strokeWidth={2} />
        ) : (
          <Pin className="size-3.5" strokeWidth={2} />
        )}
      </button>

      {/* End process */}
      <div className="flex w-7 shrink-0 justify-end">
        {port.status === "occupied" && portProcess !== null && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                onClick={(event) => event.stopPropagation()}
                aria-label={t("ports.row.killAria", {
                  name: portProcess.name,
                  port: port.port,
                })}
                className={cn(
                  ICON_BUTTON,
                  "hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive/40 focus-visible:ring-2"
                )}
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("ports.kill.title")}</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3">
                    <div className="border-border bg-background flex items-center justify-between rounded-lg border px-3 py-2.5">
                      <span className="text-foreground truncate font-medium">
                        {portProcess.name}
                      </span>
                      <span className="text-muted-foreground shrink-0 font-mono text-[12px] tabular-nums">
                        PID {portProcess.pid} · :{port.port}
                      </span>
                    </div>
                    <p>
                      {t("ports.kill.description", {
                        name: portProcess.name,
                        pid: portProcess.pid,
                        port: port.port,
                      })}
                    </p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("ports.actions.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onKill(portProcess.pid)}
                  className="bg-destructive hover:bg-destructive/90 text-white"
                >
                  {t("ports.kill.confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
});
