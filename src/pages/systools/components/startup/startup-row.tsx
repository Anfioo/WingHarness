import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  sourceFilterOf,
  startupRisk,
  type StartupArtifact,
  type StartupDesiredState,
  type StartupRiskLevel,
} from "@/lib/systools/startup";
import { cn } from "@/lib/utils";
import { ApplicationIcon } from "../uninstall/application-icon";
import { configuredStateLabelKey, startupFilterLabelKey } from "./startup-labels";

type StartupRowProps = {
  artifact: StartupArtifact;
  /** Resolved shell icon; the colored-initial badge is used while absent. */
  iconSrc?: string;
  /** Pending desired state, when the item sits in the change queue. */
  desiredState: StartupDesiredState | undefined;
  /** Localized explanation shown when the switch is disabled. */
  blockedReason: string | null;
  onToggle: (artifact: StartupArtifact) => void;
};

export const STARTUP_ROW_HEIGHT = 76;

function riskVariant(risk: StartupRiskLevel): "destructive" | "secondary" | "outline" {
  if (risk === "high") return "destructive";
  if (risk === "medium") return "secondary";
  return "outline";
}

function stateVariant(state: StartupArtifact["configuredState"]): "secondary" | "outline" {
  return state === "enabled" ? "secondary" : "outline";
}

/** One fixed-height startup item with its inline toggle. */
export function StartupRow({
  artifact,
  iconSrc,
  desiredState,
  blockedReason,
  onToggle,
}: StartupRowProps) {
  const { t } = useAppTranslation();
  const risk = startupRisk(artifact);
  const pending = desiredState !== undefined;
  const checked = (desiredState ?? artifact.configuredState) === "enabled";
  const owner = artifact.ownerName ?? artifact.publisher ?? artifact.target.executableName ?? "—";
  const visibleTriggers = artifact.triggers.slice(0, 2);
  const hiddenTriggerCount = artifact.triggers.length - visibleTriggers.length;
  const elevationHint =
    blockedReason === null && artifact.controlCapability === "elevationRequired"
      ? t("systools.startup.control.elevationRequired")
      : null;

  const toggle = (
    <Switch
      checked={checked}
      disabled={blockedReason !== null}
      onCheckedChange={() => onToggle(artifact)}
      aria-label={`${
        checked ? t("systools.startup.actions.disable") : t("systools.startup.actions.enable")
      } — ${artifact.displayName}`}
    />
  );

  return (
    <div
      data-pending={pending || undefined}
      className={cn(
        "hover:bg-muted/40 flex h-[76px] w-full items-center gap-3 rounded-md px-2 transition-colors",
        pending && "bg-accent/40 hover:bg-accent/50"
      )}
    >
      <ApplicationIcon name={artifact.displayName} src={iconSrc} className="size-9" />

      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={artifact.displayName}>
            {artifact.displayName}
          </span>
          <Badge variant="outline" className="shrink-0 text-[10px] leading-4">
            {t(startupFilterLabelKey(sourceFilterOf(artifact.sourceKind)))}
          </Badge>
          <Badge
            variant={riskVariant(risk)}
            className={cn(
              "shrink-0 text-[10px] leading-4",
              risk === "low" && "text-muted-foreground"
            )}
          >
            {t(`systools.startup.risk.${risk}`)}
          </Badge>
        </div>

        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <span className="truncate" title={owner}>
            {owner}
          </span>
          <Badge variant="outline" className="shrink-0 text-[10px] leading-4">
            {t(`systools.startup.scopes.${artifact.scope}`)}
          </Badge>
          {artifact.runtimeState !== "unknown" && (
            <span className="shrink-0">
              · {t(`systools.startup.runtime.${artifact.runtimeState}`)}
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {visibleTriggers.map((trigger, index) => (
            <Badge
              key={`${trigger}-${index}`}
              variant="outline"
              className="text-muted-foreground shrink-0 text-[10px] leading-4"
            >
              {t(`systools.startup.triggers.${trigger}`)}
            </Badge>
          ))}
          {hiddenTriggerCount > 0 && (
            <span className="text-muted-foreground shrink-0 text-[10px]">
              +{hiddenTriggerCount}
            </span>
          )}
          <Badge
            variant={stateVariant(artifact.configuredState)}
            className={cn(
              "shrink-0 text-[10px] leading-4",
              artifact.configuredState !== "enabled" && "text-muted-foreground"
            )}
          >
            {t(configuredStateLabelKey(artifact.configuredState))}
          </Badge>
        </div>
      </div>

      {blockedReason !== null || elevationHint !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="focus-visible:ring-ring/50 inline-flex shrink-0 rounded-sm focus-visible:ring-[3px]"
            >
              {toggle}
            </span>
          </TooltipTrigger>
          <TooltipContent>{blockedReason ?? elevationHint}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="inline-flex shrink-0">{toggle}</span>
      )}
    </div>
  );
}
