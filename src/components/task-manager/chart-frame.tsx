// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The frame every performance chart sits in: a 1 px border and a 25 % / sixth
// grid, both tinted with the series' own color, matching the Argus charts.

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The border and grid of a chart frame, as inline styles in the series color. */
export function chartFrameStyle(color: string): CSSProperties {
  const tint = (percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  return {
    borderColor: tint(45),
    backgroundImage: `linear-gradient(to bottom, ${tint(13)} 1px, transparent 1px), linear-gradient(to right, ${tint(13)} 1px, transparent 1px)`,
    backgroundSize: "100% 25%, calc(100% / 6) 100%",
  };
}

export function ChartFrame({
  color,
  className,
  grid = true,
  children,
}: {
  /** CSS color the frame is tinted with, e.g. `var(--perf-cpu)`. */
  color: string;
  className?: string;
  /** Draw the 25 % / sixth grid; off for a sparkline's plain frame. */
  grid?: boolean;
  children: ReactNode;
}) {
  const style = grid
    ? chartFrameStyle(color)
    : { borderColor: `color-mix(in srgb, ${color} 45%, transparent)` };
  return (
    <div className={cn("border", className)} style={style}>
      {children}
    </div>
  );
}
