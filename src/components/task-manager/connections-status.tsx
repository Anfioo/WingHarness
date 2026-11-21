// The TCP state of a connection as a small badge. UDP rows have no state and
// render a dash instead.

import type { TcpState } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const TONE: Record<TcpState, string> = {
  established: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  listen: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  synSent: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  synReceived: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  finWait1: "border-transparent bg-muted text-muted-foreground",
  finWait2: "border-transparent bg-muted text-muted-foreground",
  closeWait: "border-transparent bg-muted text-muted-foreground",
  closing: "border-transparent bg-muted text-muted-foreground",
  lastAck: "border-transparent bg-muted text-muted-foreground",
  timeWait: "border-transparent bg-muted text-muted-foreground",
  closed: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function ConnectionsStatus({ state }: { state: TcpState | null }) {
  const { t } = useAppTranslation();
  if (state === null) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn("font-normal", TONE[state])}>
      {t(`taskManager.connections.state.${state}`)}
    </Badge>
  );
}
