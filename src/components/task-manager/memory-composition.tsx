// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// A stacked bar of the disjoint parts of physical memory, drawn with the same
// colors as the panels' charts.

import { formatBytes } from "@/components/task-manager/format";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { compositionPercent, type MemoryComposition } from "@/lib/task-manager/chart-memory";

type Segment = {
  key: "used" | "modified" | "standby" | "free";
  value: number;
  color: string;
};

export function MemoryComposition({ composition }: { composition: MemoryComposition }) {
  const { t } = useAppTranslation();

  const segments: Segment[] = [
    { key: "used", value: composition.used, color: CHART_COLORS.memory },
  ];
  if (composition.modified !== null) {
    segments.push({ key: "modified", value: composition.modified, color: CHART_COLORS.diskRead });
  }
  if (composition.standby !== null) {
    segments.push({ key: "standby", value: composition.standby, color: CHART_COLORS.diskWrite });
  }
  if (composition.free !== null) {
    segments.push({ key: "free", value: composition.free, color: CHART_COLORS.free });
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={t("taskManager.performance.memory.composition")}
        className="bg-muted flex h-3 w-full overflow-hidden rounded-full"
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            title={`${t(`taskManager.performance.memory.segment.${segment.key}`)}: ${formatBytes(segment.value)}`}
            style={{
              width: `${compositionPercent(segment.value, composition.total)}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
        {segments.map((segment) => (
          <span key={segment.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
            />
            {t(`taskManager.performance.memory.segment.${segment.key}`)}
            <span className="text-foreground tabular-nums">{formatBytes(segment.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
