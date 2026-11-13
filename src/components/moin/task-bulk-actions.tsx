// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * Bulk actions for the current selection.
 *
 * The cluster sits on the filter row all the time — a button that appears only
 * once something is ticked is easy to miss — and is gated on what the selection
 * can actually do: pause needs a pausable task, resume a paused one, delete any
 * row at all.
 */
export interface TaskBulkActionsProps {
  selectedCount: number;
  visibleCount: number;
  pauseableCount: number;
  resumeableCount: number;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}

export function TaskBulkActions({
  selectedCount,
  visibleCount,
  pauseableCount,
  resumeableCount,
  onPause,
  onResume,
  onDelete,
}: TaskBulkActionsProps) {
  const { t } = useAppTranslation();
  const hasSelection = selectedCount > 0;

  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1">
      {/* First child, so the buttons keep their place and the counter grows left. */}
      {hasSelection && (
        <span className="text-muted-foreground px-1 text-xs tabular-nums">
          {t("moin.common.selectedCount", { selected: selectedCount, total: visibleCount })}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pauseableCount === 0}
        onClick={onPause}
      >
        <Pause />
        {t("moin.action.pause")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={resumeableCount === 0}
        onClick={onResume}
      >
        <Play />
        {t("moin.action.resume")}
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={!hasSelection}
        onClick={onDelete}
      >
        <Trash2 />
        {t("moin.action.delete")}
      </Button>
    </div>
  );
}
