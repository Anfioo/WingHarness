import { Sidebar } from "@/features/git/sidebar";
import { cn } from "@/lib/utils";

export function SidebarPane({ className }: { className?: string }) {
  return (
    <div className={cn("h-full overflow-hidden", className)}>
      <Sidebar />
    </div>
  );
}
