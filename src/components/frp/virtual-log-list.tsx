import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LogEntry, LogLevel } from "@/commands/services/frp/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatLogTime } from "@/lib/frp/format";
import { cn } from "@/lib/utils";

/** Fixed row height so the visible window is plain arithmetic, no dependency. */
export const VIRTUAL_LOG_ROW_HEIGHT = 22;

const OVERSCAN_ROWS = 8;
const BOTTOM_THRESHOLD_PX = 24;

const LEVEL_TONES: Record<LogLevel, string> = {
  trace: "text-muted-foreground/70",
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

export type VirtualLogListProps = {
  entries: LogEntry[];
  /** Display name per profile id; unknown ids fall back to the raw id. */
  profileNames: Record<string, string>;
  followTail: boolean;
  /** Called when scrolling away from or back to the bottom. */
  onFollowTailChange: (followTail: boolean) => void;
  className?: string;
};

/**
 * Windowed log view: only the rows near the viewport are mounted. The list
 * never grows its DOM to the buffer size, so a 2,000-line ring stays smooth.
 */
export function VirtualLogList({
  entries,
  profileNames,
  followTail,
  onFollowTailChange,
  className,
}: VirtualLogListProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const measure = () =>
      setViewport({ height: element.clientHeight, scrollTop: element.scrollTop });
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Following the tail means the newest line is always visible.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !followTail) return;
    element.scrollTop = element.scrollHeight;
    setViewport({ height: element.clientHeight, scrollTop: element.scrollTop });
  }, [entries, followTail, viewport.height]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;

    const scrollTop = element.scrollTop;
    setViewport({ height: element.clientHeight, scrollTop });

    const distanceToBottom = element.scrollHeight - scrollTop - element.clientHeight;
    if (followTail && distanceToBottom > BOTTOM_THRESHOLD_PX) {
      onFollowTailChange(false);
    } else if (!followTail && distanceToBottom <= BOTTOM_THRESHOLD_PX) {
      onFollowTailChange(true);
    }
  };

  const total = entries.length;
  const windowRows = Math.ceil(viewport.height / VIRTUAL_LOG_ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const first = Math.max(
    0,
    Math.min(total, Math.floor(viewport.scrollTop / VIRTUAL_LOG_ROW_HEIGHT) - OVERSCAN_ROWS)
  );
  const last = Math.min(total, first + windowRows);
  const visible = first < last ? entries.slice(first, last) : [];

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={cn(
        "bg-muted/20 relative overflow-y-auto rounded-lg border font-mono text-xs",
        className
      )}
    >
      <div className="relative" style={{ height: total * VIRTUAL_LOG_ROW_HEIGHT }}>
        {visible.map((entry, offset) => {
          const index = first + offset;
          const tone = LEVEL_TONES[entry.level];
          const profileName = profileNames[entry.profileId] ?? entry.profileId;
          return (
            <div
              key={index}
              className="hover:bg-accent/50 absolute right-0 left-0 flex items-center gap-2 px-2"
              style={{ top: index * VIRTUAL_LOG_ROW_HEIGHT, height: VIRTUAL_LOG_ROW_HEIGHT }}
            >
              <span className="text-muted-foreground w-[88px] shrink-0 tabular-nums">
                {formatLogTime(entry.timestamp)}
              </span>
              <span
                className="text-muted-foreground w-[120px] shrink-0 truncate"
                title={profileName}
              >
                {profileName}
              </span>
              <span className={cn("w-[52px] shrink-0 font-semibold", tone)}>
                {t(`frp.logs.level.${entry.level}`)}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", tone)} title={entry.message}>
                {entry.message}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
