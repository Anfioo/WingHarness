import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  manageableArtifactsForGroup,
  sourceFilterOf,
  startupArtifactRevealPath,
  startupGroupState,
  startupGroupSubtitle,
  startupRevealPath,
  visibleArtifactsForGroup,
  type StartupArtifact,
  type StartupDesiredState,
  type StartupOwnerGroup,
} from "@/lib/systools/startup";
import { cn } from "@/lib/utils";
import { ApplicationIcon } from "../uninstall/application-icon";
import { configuredStateLabelKey, startupFilterLabelKey } from "./startup-labels";

type StartupListProps = {
  /** Groups already narrowed by the system switch, the state tab and the search. */
  groups: StartupOwnerGroup[];
  artifactsById: ReadonlyMap<string, StartupArtifact>;
  icons: ReadonlyMap<string, string>;
  queue: ReadonlyMap<string, StartupDesiredState>;
  /** Changes whenever the filter or query changes so the list scrolls back up. */
  resetKey: string;
  blockedReason: (artifact: StartupArtifact) => string | null;
  onToggleArtifact: (artifact: StartupArtifact) => void;
  onToggleGroup: (group: StartupOwnerGroup) => void;
  onReveal: (path: string) => void;
};

/** One row per application, with its native registrations behind the chevron. */
export function StartupList({
  groups,
  artifactsById,
  icons,
  queue,
  resetKey,
  blockedReason,
  onToggleArtifact,
  onToggleGroup,
  onReveal,
}: StartupListProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  function toggleExpanded(groupId: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1 py-0.5">
      {groups.map((group) => {
        const items = visibleArtifactsForGroup(group, artifactsById);
        const state = startupGroupState(group, artifactsById);
        const manageable = manageableArtifactsForGroup(group, artifactsById);
        const subtitle = startupGroupSubtitle(group);
        const revealPath = startupRevealPath(group, artifactsById);
        const iconPath = group.iconPath ?? items.find((item) => item.iconPath)?.iconPath;
        const sourceKinds = [...new Set(items.map((item) => item.sourceKind))];
        const isOpen = expanded.has(group.groupId);
        const switchable = manageable.length > 0 && (state === "enabled" || state === "disabled");
        // Show the queued state as soon as the group switch is clicked.
        const pending =
          manageable.length > 0 && manageable.every((item) => queue.has(item.itemId))
            ? queue.get(manageable[0].itemId)
            : undefined;
        const checked = (pending ?? state) === "enabled";

        return (
          <div key={group.groupId} className="border-b border-transparent">
            <div className="hover:bg-muted/40 flex min-h-14 items-center gap-1 rounded-md px-2 py-1.5 transition-colors">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggleExpanded(group.groupId)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <ApplicationIcon
                  name={group.name}
                  src={iconPath ? icons.get(iconPath) : undefined}
                  className="size-10"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{group.name}</span>
                    {items.length > 1 && (
                      <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                        {t("systools.startup.groupItemCount", { count: items.length })}
                      </span>
                    )}
                  </div>
                  {subtitle && (
                    <p className="text-muted-foreground truncate text-xs" title={subtitle}>
                      {subtitle}
                    </p>
                  )}
                  <div className="mt-0.5 flex items-center gap-1 overflow-hidden">
                    {sourceKinds.slice(0, 2).map((kind) => (
                      <Badge
                        key={kind}
                        variant="outline"
                        className="text-[10px] leading-4 font-normal"
                      >
                        {t(startupFilterLabelKey(sourceFilterOf(kind)))}
                      </Badge>
                    ))}
                    {sourceKinds.length > 2 && (
                      <span className="text-muted-foreground text-[10px]">
                        +{sourceKinds.length - 2}
                      </span>
                    )}
                  </div>
                </div>
              </button>

              {switchable ? (
                <Switch
                  checked={checked}
                  onCheckedChange={() => onToggleGroup(group)}
                  aria-label={t(
                    checked ? "systools.startup.actions.disable" : "systools.startup.actions.enable"
                  )}
                />
              ) : (
                <Badge variant="outline" className="text-muted-foreground shrink-0 text-[10px]">
                  {t(`systools.startup.groupStates.${state}`)}
                </Badge>
              )}

              {revealPath && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("systools.startup.actions.reveal")}
                      onClick={() => onReveal(revealPath)}
                    >
                      <FolderOpen className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("systools.startup.actions.reveal")}</TooltipContent>
                </Tooltip>
              )}

              <Button
                variant="ghost"
                size="icon-xs"
                aria-expanded={isOpen}
                aria-label={t(
                  isOpen
                    ? "systools.startup.actions.collapseGroup"
                    : "systools.startup.actions.expandGroup"
                )}
                onClick={() => toggleExpanded(group.groupId)}
              >
                <ChevronDown
                  className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                />
              </Button>
            </div>

            {isOpen && (
              <div className="bg-muted/20 mx-2 mb-1.5 rounded-md border px-2 py-1">
                {items.map((artifact) => {
                  const blocked = blockedReason(artifact);
                  const pending = queue.get(artifact.itemId);
                  const artifactChecked = (pending ?? artifact.configuredState) === "enabled";
                  const artifactPath = startupArtifactRevealPath(artifact) ?? artifact.target.path;
                  const toggle = (
                    <Switch
                      checked={artifactChecked}
                      disabled={blocked !== null}
                      onCheckedChange={() => onToggleArtifact(artifact)}
                      aria-label={t(
                        artifactChecked
                          ? "systools.startup.actions.disable"
                          : "systools.startup.actions.enable"
                      )}
                    />
                  );

                  return (
                    <div
                      key={artifact.itemId}
                      data-pending={pending !== undefined || undefined}
                      className={cn(
                        "flex min-h-12 items-center gap-2 rounded-md px-1 py-1",
                        pending !== undefined && "bg-accent/40"
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="truncate text-xs font-medium"
                            title={artifact.displayName}
                          >
                            {artifact.displayName}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-muted-foreground shrink-0 text-[10px] leading-4 font-normal"
                          >
                            {t(`systools.startup.scopes.${artifact.scope}`)}
                          </Badge>
                          <Badge
                            variant={
                              artifact.configuredState === "enabled" ? "secondary" : "outline"
                            }
                            className={cn(
                              "shrink-0 text-[10px] leading-4",
                              artifact.configuredState !== "enabled" && "text-muted-foreground"
                            )}
                          >
                            {t(configuredStateLabelKey(artifact.configuredState))}
                          </Badge>
                        </div>
                        {artifactPath && (
                          <p
                            className="text-muted-foreground truncate text-[11px]"
                            title={artifactPath}
                          >
                            {artifactPath}
                          </p>
                        )}
                      </div>

                      {artifactPath && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("systools.startup.actions.reveal")}
                          onClick={() => onReveal(artifactPath)}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                      )}

                      {blocked !== null ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              tabIndex={0}
                              className="focus-visible:ring-ring/50 inline-flex shrink-0 rounded-sm focus-visible:ring-[3px]"
                            >
                              {toggle}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{blocked}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="inline-flex shrink-0">{toggle}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
