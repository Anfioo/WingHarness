import { useEffect, useState } from "react";
import { argusIcon, type StartupItem } from "@/commands";

export function StartupIcon({ item }: { item: StartupItem }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (item.icon === null) return;
    void argusIcon(item.icon)
      .then((value) => {
        if (!cancelled) setSrc(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item.icon]);
  return src ? (
    <img src={src} alt="" className="size-5 shrink-0 object-contain" />
  ) : (
    <span className="bg-muted size-5 shrink-0 rounded" aria-hidden />
  );
}
