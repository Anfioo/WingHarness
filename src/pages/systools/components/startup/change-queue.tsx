import { ArrowRight, ListChecks, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { StartupConfiguredState, StartupDesiredState } from "@/lib/systools/startup";
import { configuredStateLabelKey, desiredStateLabelKey } from "./startup-labels";

export type StartupQueueEntry = {
  itemId: string;
  displayName: string;
  previousState: StartupConfiguredState;
  desiredState: StartupDesiredState;
};

type ChangeQueueProps = {
  entries: StartupQueueEntry[];
  /** True while a prepared plan is being reviewed or applied. */
  busy: boolean;
  onRemove: (itemId: string) => void;
  onClear: () => void;
  onReview: () => void;
};

/** The pending toggle changes, with previous and requested states. */
export function ChangeQueue({ entries, busy, onRemove, onClear, onReview }: ChangeQueueProps) {
  const { t } = useAppTranslation();

  if (entries.length === 0) return null;

  return (
    <div className="shrink-0 border-t px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t("systools.startup.queue.title")}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("systools.startup.queue.selected", { count: entries.length })}
        </span>
        <Button variant="ghost" size="xs" onClick={onClear} disabled={busy}>
          {t("systools.startup.queue.clear")}
        </Button>
        <Button size="sm" className="ml-auto" onClick={onReview} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ListChecks className="size-4" />}
          {t("systools.startup.queue.apply")}
        </Button>
      </div>

      <ul className="mt-1.5 max-h-28 divide-y overflow-y-auto rounded-md border">
        {entries.map((entry) => (
          <li key={entry.itemId} className="flex items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1 truncate text-xs" title={entry.displayName}>
              {entry.displayName}
            </span>
            <Badge
              variant="outline"
              className="text-muted-foreground shrink-0 text-[10px] leading-4"
            >
              {t(configuredStateLabelKey(entry.previousState))}
            </Badge>
            <ArrowRight className="text-muted-foreground size-3 shrink-0" />
            <Badge
              variant={entry.desiredState === "enabled" ? "secondary" : "outline"}
              className="shrink-0 text-[10px] leading-4"
            >
              {t(desiredStateLabelKey(entry.desiredState))}
            </Badge>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${t("systools.startup.queue.remove")}: ${entry.displayName}`}
              title={t("systools.startup.queue.remove")}
              onClick={() => onRemove(entry.itemId)}
              disabled={busy}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
