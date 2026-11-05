import { useState } from "react";
import { cn } from "@/lib/utils";

const FALLBACK_TONES = [
  "bg-primary/15 text-primary",
  "bg-secondary text-secondary-foreground",
  "bg-accent text-accent-foreground",
  "bg-muted text-muted-foreground",
] as const;

function toneFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return FALLBACK_TONES[hash % FALLBACK_TONES.length];
}

type ApplicationIconProps = {
  name: string;
  /** Data URL resolved by `systools_application_icons`; omitted while loading. */
  src?: string;
  className?: string;
};

/** Shell icon with a stable colored-initial fallback for missing artwork. */
export function ApplicationIcon({ name, src, className }: ApplicationIconProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && src !== failedSrc;
  const initial = name.trim().charAt(0).toLocaleUpperCase() || "?";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md",
        !showImage && toneFor(name),
        className
      )}
    >
      {showImage && src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="size-full object-contain"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span className="text-xs font-semibold">{initial}</span>
      )}
    </span>
  );
}
