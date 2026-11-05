import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  applicationBytes,
  applicationSourceLabelKey,
  formatApplicationDate,
  type ApplicationUninstallCandidate,
  type ApplicationUninstallCapability,
  type ApplicationUninstallInventorySource,
} from "@/lib/systools/applications";
import { formatBytes } from "@/lib/systools/format";
import { cn } from "@/lib/utils";
import { ApplicationIcon } from "./application-icon";
import { SelectionCheckbox } from "../common/selection-checkbox";

type ApplicationRowProps = {
  candidate: ApplicationUninstallCandidate;
  iconSrc?: string;
  selected: boolean;
  disabled: boolean;
  /** Human-readable explanation shown when the checkbox is disabled. */
  disabledReason: string | null;
  onToggle: () => void;
  onOpen: () => void;
};

function uniqueSources(
  candidate: ApplicationUninstallCandidate
): ApplicationUninstallInventorySource[] {
  const seen = new Set<ApplicationUninstallInventorySource>();
  for (const identity of candidate.sourceIdentities) seen.add(identity.source);
  return [...seen];
}

function capabilityVariant(
  capability: ApplicationUninstallCapability
): "default" | "secondary" | "outline" {
  if (capability === "ready") return "secondary";
  if (capability === "protectedApplication") return "secondary";
  return "outline";
}

function capabilityTone(capability: ApplicationUninstallCapability): string {
  switch (capability) {
    case "ready":
      return "text-foreground";
    case "applicationRunning":
      return "text-foreground";
    case "requiresElevation":
      return "text-muted-foreground";
    case "protectedApplication":
      return "text-muted-foreground";
    case "viewOnly":
      return "text-muted-foreground";
  }
}

export const APPLICATION_ROW_HEIGHT = 56;

/** One fixed-height catalog row. */
export function ApplicationRow({
  candidate,
  iconSrc,
  selected,
  disabled,
  disabledReason,
  onToggle,
  onOpen,
}: ApplicationRowProps) {
  const { t, language } = useAppTranslation();
  const sources = uniqueSources(candidate);
  const installed = candidate.dates.installed;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("systools.uninstall.columns.name") + ": " + candidate.name}
      data-selected={selected}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "hover:bg-muted/40 focus-visible:bg-muted/40 flex h-14 cursor-pointer items-center gap-3 rounded-md px-2 transition-colors outline-none",
        selected && "bg-accent/50 hover:bg-accent/60"
      )}
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center"
        onClick={(event) => event.stopPropagation()}
      >
        {disabledReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="focus-visible:ring-ring/50 inline-flex rounded-sm focus-visible:ring-[3px]"
              >
                <SelectionCheckbox
                  checked={selected}
                  disabled={disabled}
                  aria-label={t("systools.uninstall.actions.selectApplication", {
                    name: candidate.name,
                  })}
                  onCheckedChange={() => onToggle()}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{disabledReason}</TooltipContent>
          </Tooltip>
        ) : (
          <SelectionCheckbox
            checked={selected}
            disabled={disabled}
            aria-label={t("systools.uninstall.actions.selectApplication", { name: candidate.name })}
            onCheckedChange={() => onToggle()}
          />
        )}
      </span>

      <ApplicationIcon name={candidate.name} src={iconSrc} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{candidate.name}</span>
          {sources.slice(0, 2).map((source) => (
            <Badge
              key={source}
              variant="outline"
              className="text-muted-foreground hidden text-[10px] leading-4 sm:inline-flex"
            >
              {t(`systools.uninstall.sources.${applicationSourceLabelKey(source)}`)}
            </Badge>
          ))}
        </div>
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <span className="truncate">{candidate.publisher ?? candidate.primaryIdentifier}</span>
          {candidate.version && (
            <span className="truncate">
              · {t("systools.uninstall.columns.version", { version: candidate.version })}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="text-muted-foreground hidden w-24 text-right text-xs md:block">
          {installed
            ? formatApplicationDate(installed.timestampMs, language)
            : t("systools.uninstall.columns.unknownDate")}
        </span>
        <span className="w-20 text-right text-xs tabular-nums">
          {applicationBytes(candidate) > 0
            ? formatBytes(applicationBytes(candidate), language)
            : t("systools.uninstall.columns.unknownSize")}
        </span>
        <Badge
          variant={capabilityVariant(candidate.capability)}
          className={cn("min-w-16 justify-center", capabilityTone(candidate.capability))}
        >
          {t(`systools.uninstall.capabilities.${candidate.capability}`)}
        </Badge>
      </div>
    </div>
  );
}
