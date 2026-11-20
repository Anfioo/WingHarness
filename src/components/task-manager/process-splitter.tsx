// The handle on the details panel's left edge: drag it, use the arrow keys, or
// double-click for the default width. A vertical twin of `share-splitter`,
// which sits between stacked chart areas.

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export const DETAIL_WIDTH_DEFAULT = 360;
export const DETAIL_WIDTH_MIN = 280;
export const DETAIL_WIDTH_MAX = 520;
const STEP = 16;

export function clampDetailWidth(width: number): number {
  if (!Number.isFinite(width)) return DETAIL_WIDTH_DEFAULT;
  return Math.round(Math.min(DETAIL_WIDTH_MAX, Math.max(DETAIL_WIDTH_MIN, width)));
}

export function ProcessSplitter({
  width,
  onChange,
  label,
  className,
}: {
  width: number;
  onChange: (width: number) => void;
  label: string;
  className?: string;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    event.preventDefault();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    // The panel is on the right: dragging its edge left makes it wider.
    onChange(clampDetailWidth(current.startWidth - (event.clientX - current.startX)));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowLeft"
        ? STEP
        : event.key === "ArrowRight"
          ? -STEP
          : event.key === "Home"
            ? DETAIL_WIDTH_MIN - width
            : event.key === "End"
              ? DETAIL_WIDTH_MAX - width
              : 0;
    if (delta === 0) return;
    event.preventDefault();
    onChange(clampDetailWidth(width + delta));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={DETAIL_WIDTH_MIN}
      aria-valuemax={DETAIL_WIDTH_MAX}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={key}
      onDoubleClick={() => onChange(DETAIL_WIDTH_DEFAULT)}
      className={cn(
        "group absolute inset-y-0 -left-2 z-10 w-4 cursor-col-resize touch-none outline-none",
        className
      )}
    >
      <span
        aria-hidden
        className="bg-border group-hover:bg-muted-foreground/60 group-focus-visible:bg-muted-foreground/60 group-active:bg-primary absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors"
      />
    </div>
  );
}
