import type { MoinTaskProgress } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatPercent, percent } from "@/lib/moin/format";

/**
 * The progress bar drawn under a task row.
 *
 * A segmented transfer reports one byte range per connection, so the bar is one
 * track per connection: each track's width follows its share of the file and its
 * fill follows that connection's own position. Transfers that report no segments
 * (a single stream, or aria2) fall back to one aggregate bar.
 */
export function SegmentBar({ progress }: { progress: MoinTaskProgress }) {
  const { t } = useAppTranslation();
  const segments = progress.segments;

  if (segments.length <= 1) {
    const completion = percent(progress.received, progress.total);
    return (
      <div
        role="img"
        aria-label={t("moin.task.progress")}
        className="bg-muted h-1.5 overflow-hidden rounded-full"
      >
        {completion === null ? (
          <div className="bg-primary h-full w-1/3 animate-pulse rounded-full" />
        ) : (
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-200"
            style={{ width: `${completion}%` }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div role="img" aria-label={t("moin.task.progress")} className="flex min-w-0 flex-1 gap-px">
        {segments.map((segment, index) => {
          const length = Math.max(1, segment.end - segment.start + 1);
          const received = Math.min(length, Math.max(0, segment.position - segment.start));
          const share = (received / length) * 100;
          return (
            <div
              key={`${segment.start}-${segment.end}`}
              title={t("moin.task.segmentTooltip", {
                index: index + 1,
                percent: formatPercent(share),
              })}
              className="bg-muted h-1.5 overflow-hidden rounded-full"
              style={{ flexBasis: 0, flexGrow: length }}
            >
              <div
                className="bg-primary h-full transition-[width] duration-200"
                style={{ width: `${share}%` }}
              />
            </div>
          );
        })}
      </div>
      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
        {t("moin.task.connections", { count: segments.length })}
      </span>
    </div>
  );
}
