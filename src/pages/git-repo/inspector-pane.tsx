import { Inspector } from "@/features/git/inspector";
import { cn } from "@/lib/utils";

export function InspectorPane({ className }: { className?: string }) {
  return (
    <div className={cn("h-full overflow-hidden", className)}>
      <Inspector />
    </div>
  );
}
