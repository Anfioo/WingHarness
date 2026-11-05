import type { ProcessState, TunnelState } from "@/commands/services/frp/types";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const ACTIVE_STATES: ReadonlySet<ProcessState> = new Set<ProcessState>([
  "starting",
  "running",
  "reconnecting",
  "stopping",
]);

/** True while the profile has a process that is up or on its way up/down. */
export function isActiveProcessState(state: ProcessState | null | undefined): boolean {
  return state !== null && state !== undefined && ACTIVE_STATES.has(state);
}

const TONE: Record<ProcessState | TunnelState, string> = {
  running: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  online: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  starting: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  reconnecting: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  stopping: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  stopped: "text-muted-foreground",
  offline: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

export type StateBadgeProps = {
  state: ProcessState | TunnelState;
  className?: string;
};

/** Process or tunnel state, colored by severity and labeled through `frp.status.*`. */
export function StateBadge({ state, className }: StateBadgeProps) {
  const { t } = useAppTranslation();

  return (
    <Badge variant="outline" className={cn(TONE[state], className)}>
      {t(`frp.status.${state}`)}
    </Badge>
  );
}
