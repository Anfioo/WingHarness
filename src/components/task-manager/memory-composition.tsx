// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// A stacked bar of the disjoint parts of physical memory, in shades of the
// memory hue as on the Argus page. The free part is the empty rest of the bar.

import { formatBytes } from "@/components/task-manager/format";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { compositionPercent, type MemoryComposition } from "@/lib/task-manager/chart-memory";

type Segment = {
  key: "used" | "modified" | "standby" | "free";
  value: number;
  color: string;
};

/** A shade of the memory hue; the free part keeps the neutral border color. */
function memShade(percent: number): string {
  return `color-mix(in srgb, var(--perf-mem) ${percent}%, transparent)`;
}

export function MemoryComposition({ composition }: { composition: MemoryComposition }) {
  const { t } = useAppTranslation();
  const label = (segment: Segment) =>
    `${t(`taskManager.performance.memory.segment.${segment.key}`)} ${formatBytes(segment.value)}`;

  // Painted parts; the free part is what the bar leaves empty.
  const parts: Segment[] = [{ key: "used", value: composition.used, color: memShade(55) }];
  if (composition.modified !== null) {
    parts.push({ key: "modified", value: composition.modified, color: memShade(90) });
  }
  if (composition.standby !== null) {
    parts.push({ key: "standby", value: composition.standby, color: memShade(20) });
  }
  const legend: Segment[] = [...parts];
  if (composition.free !== null) {
    legend.push({ key: "free", value: composition.free, color: "var(--border)" });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="img"
        aria-label={`${t("taskManager.performance.memory.composition")}: ${legend.map(label).join(", ")}`}
        className="flex h-7 w-full overflow-hidden rounded-[4px] border"
        style={{ borderColor: memShade(45) }}
      >
        {parts.map((segment) => (
          <div
            key={segment.key}
            title={label(segment)}
            style={{
              width: `${compositionPercent(segment.value, composition.total)}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        {legend.map((segment) => (
          <span key={segment.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[2px]"
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
