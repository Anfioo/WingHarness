// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The right-click menu of one service. The tab owns the side effects; this
// component only decides what is enabled and which callback to call.

import { Copy, FolderOpen, Play, Power, RotateCw, Square } from "lucide-react";
import type { ServiceAction, ServiceInfo, ServiceStartType } from "@/commands";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { isServicePending } from "@/lib/task-manager/service-rows";

/** The start types the menu can set; boot and system are read-only. */
export const SERVICE_START_TYPES: readonly ServiceStartType[] = [
  "auto",
  "autoDelayed",
  "manual",
  "disabled",
];

/** The executable at the front of a service command line, quoted or not. */
export function serviceBinaryPath(path: string | null): string | null {
  if (!path) return null;
  const match = path.match(/^"([^"]+)"|^(\S+)/);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

export type ServiceActions = {
  /** Services with an action in flight; their menu entries wait for it. */
  busy: ReadonlySet<string>;
  onControl: (service: ServiceInfo, action: ServiceAction) => void;
  onStartType: (service: ServiceInfo, startType: ServiceStartType) => void;
  onCopyName: (service: ServiceInfo) => void;
  onOpenLocation: (service: ServiceInfo) => void;
};

export function ServiceContextMenuContent({
  service,
  actions,
}: {
  service: ServiceInfo;
  actions: ServiceActions;
}) {
  const { t } = useAppTranslation();
  const pending = actions.busy.has(service.name) || isServicePending(service);
  const binary = serviceBinaryPath(service.path);

  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem
        disabled={pending || service.state === "running"}
        onSelect={() => actions.onControl(service, "start")}
      >
        <Play />
        {t("taskManager.services.actions.start")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={pending || !service.canStop}
        onSelect={() => actions.onControl(service, "stop")}
      >
        <Square />
        {t("taskManager.services.actions.stop")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={pending || !service.canStop}
        onSelect={() => actions.onControl(service, "restart")}
      >
        <RotateCw />
        {t("taskManager.services.actions.restart")}
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={pending}>
          <Power />
          {t("taskManager.services.menu.startType")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-52">
          <ContextMenuRadioGroup
            value={service.startType ?? ""}
            onValueChange={(value) => actions.onStartType(service, value as ServiceStartType)}
          >
            {SERVICE_START_TYPES.map((type) => (
              <ContextMenuRadioItem key={type} value={type}>
                {t(`taskManager.services.startType.${type}`)}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => actions.onCopyName(service)}>
        <Copy />
        {t("taskManager.services.menu.copyName")}
      </ContextMenuItem>
      <ContextMenuItem disabled={binary === null} onSelect={() => actions.onOpenLocation(service)}>
        <FolderOpen />
        {t("taskManager.services.menu.openLocation")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
