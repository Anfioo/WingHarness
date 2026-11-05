import { useMemo } from "react";
import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useRepo } from "@/features/git/repository-store";
import { GUTTER_GAP, laneX, REF_COL_WIDTH } from "./graph-row";
import { useGraph } from "./store";
import { useUi } from "@/features/git/ui-store";
import { useAppTranslation } from "@/hooks/use-app-translation";

export function WipRow({
  gutterWidth,
  showRefs = true,
}: {
  gutterWidth: number;
  showRefs?: boolean;
}) {
  const { t } = useAppTranslation();
  const status = useRepo((s) => s.status);
  const conflicts = useRepo((s) => s.conflicts);
  const select = useGraph((s) => s.select);
  const selectedOid = useGraph((s) => s.selectedOid);
  const closeCenterDiff = useUi((s) => s.closeCenterDiff);

  const counts = useMemo(() => {
    const files = status?.files ?? [];
    return {
      total: files.length,
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => f.unstaged).length,
      conflicted: conflicts.length,
    };
  }, [status, conflicts]);

  if (counts.total === 0) return null;

  const focusWorkingCopy = () => {
    select(null);
    closeCenterDiff();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("gitRepo.graph.wip.aria", { count: counts.total })}
      onClick={focusWorkingCopy}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") focusWorkingCopy();
      }}
      className={cn(
        "border-primary/40 sticky top-0 z-10 flex h-9 cursor-pointer items-center gap-2 border-b border-dashed pr-4 text-sm select-none",
        showRefs ? "pl-1" : "pl-4",
        "bg-card/95 hover:bg-primary/10 backdrop-blur-sm transition-colors",
        selectedOid === null && "bg-primary/10"
      )}
    >
      {showRefs && <span className="h-full shrink-0" style={{ width: REF_COL_WIDTH }} />}
      <svg
        width={gutterWidth}
        height={36}
        className="shrink-0"
        style={{ marginRight: GUTTER_GAP }}
        aria-hidden
      >
        <line
          x1={laneX(0)}
          y1={18}
          x2={laneX(0)}
          y2={36}
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          strokeDasharray="3 3"
        />
        <circle
          cx={laneX(0)}
          cy={18}
          r={4.5}
          fill="hsl(var(--card))"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          strokeDasharray="3 2.5"
        />
      </svg>
      <Pencil className="text-primary size-3.5 shrink-0" />
      <span className="border-primary/50 text-primary rounded border border-dashed px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase">
        {t("gitRepo.graph.wip.label")}
      </span>
      <span className="text-muted-foreground min-w-0 truncate">
        {t("gitRepo.graph.wip.changes", { count: counts.total })}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {counts.conflicted > 0 && (
          <Badge variant="destructive">
            {t("gitRepo.graph.wip.conflicted", { count: counts.conflicted })}
          </Badge>
        )}
        {counts.staged > 0 && (
          <Badge variant="outline" className="border-success/40 bg-success/15 text-success">
            {t("gitRepo.graph.wip.staged", { count: counts.staged })}
          </Badge>
        )}
        {counts.unstaged > 0 && (
          <Badge variant="outline" className="border-info/40 bg-info/15 text-info">
            {t("gitRepo.graph.wip.modified", { count: counts.unstaged })}
          </Badge>
        )}
        <span className="border-primary/40 text-primary rounded-md border px-2 py-0.5 text-[11px] font-medium">
          {t("gitRepo.graph.wip.viewChanges")}
        </span>
      </span>
    </div>
  );
}
