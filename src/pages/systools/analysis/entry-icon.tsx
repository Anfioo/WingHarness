import { useEffect, useState } from "react";
import { File, Folder } from "lucide-react";
import { systemFileIcon } from "@/lib/space-preview/bridge";
import type { DirectoryEntryInfo } from "@/lib/systools/storage";
import { cn } from "@/lib/utils";

type AnalysisEntryIconProps = {
  entry: Pick<DirectoryEntryInfo, "name" | "path" | "isDirectory">;
  className?: string;
};

/** The shell's own icon for an entry, falling back to a generic glyph while it loads. */
export function AnalysisEntryIcon({ entry, className }: AnalysisEntryIconProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSrc(null);
    void systemFileIcon(entry.name, entry.path, entry.isDirectory).then((url) => {
      if (active) setSrc(url ?? null);
    });
    return () => {
      active = false;
    };
  }, [entry.name, entry.path, entry.isDirectory]);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        aria-hidden="true"
        className={cn("size-4 shrink-0 object-contain", className)}
      />
    );
  }

  const Icon = entry.isDirectory ? Folder : File;
  return (
    <Icon aria-hidden="true" className={cn("text-muted-foreground size-3.5 shrink-0", className)} />
  );
}
