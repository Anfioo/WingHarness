import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { StartupItem } from "@/commands";

export function StartupStatus({
  item,
  pending,
  onChange,
}: {
  item: StartupItem;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const label = item.enabled
    ? t("taskManager.startup.status.enabled")
    : t("taskManager.startup.status.disabled");
  if (!item.blocked)
    return (
      <div className="flex items-center gap-2">
        <Switch
          checked={item.enabled}
          disabled={pending}
          onCheckedChange={onChange}
          aria-label={label}
        />
        <span className="text-muted-foreground text-xs">{label}</span>
      </div>
    );
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Switch checked={item.enabled} disabled aria-label={label} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t(`taskManager.startup.blocked.${item.blocked}`)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
