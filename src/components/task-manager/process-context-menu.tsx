// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The right-click menu of one process, and the action contract shared by the
// table, the detail panel and the page.

import { Leaf, ListX, ShieldAlert, Skull, SlidersHorizontal } from "lucide-react";
import type { Priority, ProcessRow } from "@/commands";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { isOwnProcess, isSystemProcess, priorityOf } from "@/lib/task-manager/process-identity";
import { cn } from "@/lib/utils";

export const PRIORITIES: readonly Priority[] = [
  "realtime",
  "high",
  "aboveNormal",
  "normal",
  "belowNormal",
  "idle",
];

/** What the menus and detail actions may do; the page owns their side effects. */
export type ProcessActions = {
  /** The privileged service is running, so system processes can be acted on. */
  serviceReady: boolean;
  /** Executable names of this app; its own process is never ended from here. */
  selfNames: ReadonlySet<string>;
  onRequestKill: (process: ProcessRow) => void;
  onRequestKillTree: (process: ProcessRow) => void;
  onSetPriority: (process: ProcessRow, priority: Priority) => void;
  onRequestRealtime: (process: ProcessRow) => void;
  onSetEfficiency: (process: ProcessRow, on: boolean) => void;
};

export function ProcessContextMenuContent({
  process,
  actions,
}: {
  process: ProcessRow;
  actions: ProcessActions;
}) {
  const { t } = useAppTranslation();
  const own = isOwnProcess(process, actions.selfNames);
  const needsService = isSystemProcess(process) && !actions.serviceReady;
  const endDisabled = own || needsService;
  const current = priorityOf(process.basePriority);

  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem
        variant="destructive"
        disabled={endDisabled}
        onSelect={() => actions.onRequestKill(process)}
      >
        <Skull />
        {t("taskManager.actions.kill")}
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        disabled={endDisabled}
        onSelect={() => actions.onRequestKillTree(process)}
      >
        <ListX />
        {t("taskManager.actions.killTree")}
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={needsService}>
          <SlidersHorizontal />
          {t("taskManager.actions.priority")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          <ContextMenuRadioGroup
            value={current ?? ""}
            onValueChange={(value) => {
              const priority = value as Priority;
              if (priority === "realtime") actions.onRequestRealtime(process);
              else actions.onSetPriority(process, priority);
            }}
          >
            {PRIORITIES.map((priority) => (
              <ContextMenuRadioItem key={priority} value={priority}>
                {t(`taskManager.details.priority.${priority}`)}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuItem
        disabled={needsService}
        onSelect={() => actions.onSetEfficiency(process, !process.efficiency)}
      >
        <Leaf className={cn(process.efficiency && "text-emerald-600 dark:text-emerald-400")} />
        {t(
          process.efficiency
            ? "taskManager.actions.efficiencyOff"
            : "taskManager.actions.efficiencyOn"
        )}
      </ContextMenuItem>

      {(own || needsService) && (
        <>
          <ContextMenuSeparator />
          {own && (
            <ContextMenuLabel className="text-muted-foreground flex items-start gap-2 text-xs font-normal">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="whitespace-normal">{t("taskManager.process.selfHint")}</span>
            </ContextMenuLabel>
          )}
          {needsService && (
            <ContextMenuLabel className="text-muted-foreground flex items-start gap-2 text-xs font-normal">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="whitespace-normal">
                {t("taskManager.process.systemNeedsService")}
              </span>
            </ContextMenuLabel>
          )}
        </>
      )}
    </ContextMenuContent>
  );
}
