import { dirname } from "@/features/git/utils";
import { cn } from "@/lib/utils";

export function DirName({ path, className }: { path: string; className?: string }) {
  const dir = dirname(path);
  if (!dir) return null;
  return (
    <span dir="rtl" className={cn("text-faint min-w-0 flex-1 truncate text-left", className)}>
      <bdi>{dir}</bdi>
    </span>
  );
}
