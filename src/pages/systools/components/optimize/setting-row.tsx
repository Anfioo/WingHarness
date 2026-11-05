import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  isSettingSelectable,
  type SystemSettingItem,
  type SystemSettingRiskLevel,
  type SystemSettingTargetState,
} from "@/lib/systools/system-settings";
import { cn } from "@/lib/utils";
import {
  diagnosticReasonKey,
  settingDescriptionKey,
  settingFallbackName,
  settingNameKey,
} from "./setting-labels";

type SettingRowProps = {
  item: SystemSettingItem;
  pendingTarget?: SystemSettingTargetState;
  busy: boolean;
  onToggle: () => void;
};

function riskBadgeVariant(risk: SystemSettingRiskLevel): "outline" | "secondary" | "destructive" {
  switch (risk) {
    case "high":
      return "destructive";
    case "caution":
      return "secondary";
    case "standard":
      return "outline";
  }
}

/** One setting with its risk/status badges, hints, and inline switch. */
export function SettingRow({ item, pendingTarget, busy, onToggle }: SettingRowProps) {
  const { t } = useAppTranslation();

  const selectable = isSettingSelectable(item);
  const name = t(settingNameKey(item.settingId), {
    defaultValue: settingFallbackName(item.settingId),
  });
  const description = t(settingDescriptionKey(item.settingId), { defaultValue: "" });
  const desired = pendingTarget ?? (item.status === "optimized" ? "optimized" : "default");
  const unavailableReason =
    item.status === "unavailable"
      ? t(
          item.diagnostic
            ? diagnosticReasonKey(item.diagnostic)
            : "systools.optimize.status.unavailable"
        )
      : null;

  const control = (
    <Switch
      checked={desired === "optimized"}
      disabled={!selectable || busy}
      onCheckedChange={onToggle}
      aria-label={name}
    />
  );

  return (
    <li
      className={cn(
        "flex items-start gap-3 px-3 py-2",
        item.status === "unavailable" && "opacity-70"
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{name}</span>
          <Badge variant={riskBadgeVariant(item.riskLevel)} className="text-[10px]">
            {t(`systools.optimize.risk.${item.riskLevel}`)}
          </Badge>
          <Badge
            variant={item.status === "recommended" ? "secondary" : "outline"}
            className="text-[10px]"
          >
            {t(`systools.optimize.status.${item.status}`)}
          </Badge>
          <Badge variant="outline" className="text-muted-foreground text-[10px]">
            {t(`systools.optimize.kind.${item.selectionKind}`)}
          </Badge>
          {item.requiresRestart && (
            <Badge variant="outline" className="text-[10px]">
              {t("systools.optimize.badges.requiresRestart")}
            </Badge>
          )}
          {item.requiresElevation && (
            <Badge variant="outline" className="text-[10px]">
              {t("systools.optimize.badges.requiresElevation")}
            </Badge>
          )}
        </div>

        <p className="text-muted-foreground truncate text-xs" title={description || item.settingId}>
          {description || item.settingId}
        </p>

        {pendingTarget && (
          <p className="text-primary flex items-center gap-1 text-[11px]">
            <ArrowRight className="size-3 shrink-0" />
            {pendingTarget === "optimized"
              ? t("systools.optimize.status.optimized")
              : t("systools.optimize.actions.restore")}
          </p>
        )}
      </div>

      {unavailableReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-help" tabIndex={0} title={unavailableReason}>
              {control}
            </span>
          </TooltipTrigger>
          <TooltipContent side="left">{unavailableReason}</TooltipContent>
        </Tooltip>
      ) : (
        control
      )}
    </li>
  );
}
