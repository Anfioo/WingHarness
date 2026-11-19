// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The handle between two stacked chart areas: drag it, use the arrow keys, or
// double-click for the default. `share` is the upper area's fraction.

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export const SHARE_DEFAULT = 0.6;
export const SHARE_MIN = 0.3;
export const SHARE_MAX = 0.85;

export function clampShare(value: number): number {
  if (!Number.isFinite(value)) return SHARE_DEFAULT;
  return Math.min(SHARE_MAX, Math.max(SHARE_MIN, value));
}

export function ShareSplitter({
  share,
  onChange,
  label,
  className,
}: {
  share: number;
  onChange: (share: number) => void;
  label: string;
  className?: string;
}) {
  const drag = useRef<{ startY: number; startShare: number; total: number } | null>(null);

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const above = handle.previousElementSibling?.getBoundingClientRect().height ?? 0;
    const below = handle.nextElementSibling?.getBoundingClientRect().height ?? 0;
    if (above + below <= 0) return;
    handle.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startShare: share, total: above + below };
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    onChange(clampShare(current.startShare + (event.clientY - current.startY) / current.total));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowUp" ? -0.05 : event.key === "ArrowDown" ? 0.05 : 0;
    if (step === 0 && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    onChange(
      event.key === "Home" ? SHARE_MIN : event.key === "End" ? SHARE_MAX : clampShare(share + step)
    );
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={Math.round(SHARE_MIN * 100)}
      aria-valuemax={Math.round(SHARE_MAX * 100)}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={key}
      onDoubleClick={() => onChange(SHARE_DEFAULT)}
      className={cn(
        "group relative h-[18px] flex-none cursor-row-resize touch-none outline-none",
        className
      )}
    >
      <span
        aria-hidden
        className="bg-border group-hover:bg-muted-foreground/60 group-focus-visible:bg-muted-foreground/60 group-active:bg-primary absolute top-2 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full opacity-50 transition-colors group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100"
      />
    </div>
  );
}
