import { Copy, FolderOpen, Power } from "lucide-react";
import { revealPath, type StartupItem } from "@/commands";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";

export function StartupContextMenu({
  item,
  children,
  onToggle,
}: {
  item: StartupItem;
  children: React.ReactNode;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={Boolean(item.blocked)} onSelect={() => onToggle(!item.enabled)}>
          <Power />
          {t(
            item.enabled
              ? "taskManager.startup.actions.disable"
              : "taskManager.startup.actions.enable"
          )}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!item.path}
          onSelect={() => {
            if (item.path) void revealPath(item.path);
          }}
        >
          <FolderOpen />
          {t("taskManager.startup.actions.openLocation")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(item.command)}>
          <Copy />
          {t("taskManager.startup.actions.copyCommand")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
