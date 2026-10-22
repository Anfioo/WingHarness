import { useEffect, useState } from "react";
import { fontsList } from "@/commands";
import type { FontFamily } from "@/commands";

let cache: Promise<FontFamily[]> | null = null;

export function loadInstalledFonts(force = false): Promise<FontFamily[]> {
  if (!cache || force) cache = fontsList().catch(() => [] as FontFamily[]);
  return cache;
}

export function useInstalledFonts(): { fonts: FontFamily[]; loading: boolean } {
  const [fonts, setFonts] = useState<FontFamily[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadInstalledFonts().then((next) => {
      if (cancelled) return;
      setFonts(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { fonts, loading };
}
