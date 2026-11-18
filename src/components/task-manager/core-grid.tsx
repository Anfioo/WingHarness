// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Per-logical-processor load, one small bar each. The grid reflows with the
// panel's width instead of fixing a column count, so 8 and 32-thread machines
// both stay readable.

import { formatPercent } from "@/components/task-manager/format";
import { useAppTranslation } from "@/hooks/use-app-translation";

export function CoreGrid({
  cores,
  coreMhz,
}: {
  cores: readonly (number | null)[];
  /** Per-logical-processor frequency; the row stays hidden when empty. */
  coreMhz?: readonly number[];
}) {
  const { t } = useAppTranslation();
  if (cores.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t("taskManager.performance.cpu.cores")}
      className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-2"
    >
      {cores.map((value, index) => {
        const percent =
          value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value));
        const mhz = coreMhz?.[index];
        return (
          <div key={index} className="flex min-w-0 flex-col gap-1">
            <div className="text-muted-foreground flex justify-between gap-2 text-[10px] tabular-nums">
              <span>{index}</span>
              <span>{formatPercent(value ?? Number.NaN, 0)}</span>
            </div>
            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-linear"
                style={{
                  width: `${percent ?? 0}%`,
                  backgroundColor: "var(--primary)",
                }}
              />
            </div>
            {mhz !== undefined && Number.isFinite(mhz) && (
              <span className="text-muted-foreground text-[9px] tabular-nums">
                {(mhz / 1000).toFixed(2)} GHz
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
