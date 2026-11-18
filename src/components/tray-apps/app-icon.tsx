import { useEffect, useState } from "react";
import type { TrayApp } from "@/commands";
import { systemFileIcon } from "@/lib/space-preview/bridge";
import { cn } from "@/lib/utils";

/**
 * The swatches a shortcut without an icon falls back to: stable per app id, so
 * the same app keeps the same colour on every open.
 */
const SWATCH_COLORS = [
  "oklch(60% 0.17 254)",
  "oklch(56% 0.15 285)",
  "oklch(58% 0.16 338)",
  "oklch(58% 0.18 28)",
  "oklch(63% 0.17 53)",
  "oklch(70% 0.16 88)",
  "oklch(68% 0.16 125)",
  "oklch(66% 0.14 155)",
  "oklch(68% 0.12 190)",
  "oklch(64% 0.14 215)",
  "oklch(60% 0.14 235)",
  "oklch(58% 0.14 270)",
];

function colorFor(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return SWATCH_COLORS[Math.abs(hash) % SWATCH_COLORS.length];
}

/**
 * A Scoop app's icon, read from its Start Menu shortcut through the shell.
 *
 * The shortcut is what carries the icon, so there is nothing to extract from an
 * executable here. A shortcut the shell has no icon for — or a machine where the
 * read failed — falls back to a coloured letter, which keeps every row aligned
 * instead of leaving a hole.
 */
export function TrayAppIcon({
  app,
  size = 16,
  className,
}: {
  app: TrayApp;
  size?: number;
  className?: string;
}) {
  const [icon, setIcon] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setIcon(undefined);
    void systemFileIcon(app.id, app.path).then((data) => {
      if (alive) setIcon(data);
    });
    return () => {
      alive = false;
    };
  }, [app.id, app.path]);

  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-[3px]", className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-[4px] font-bold text-white select-none",
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.5)),
        background: colorFor(app.id),
      }}
    >
      {app.displayName.charAt(0).toUpperCase()}
    </span>
  );
}
