import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PaneEmptyProps {
  icon: ReactNode;
  title: string;
  hint?: string;
  children?: ReactNode;
  className?: string;
}

/** Centered placeholder used by every pane until its real content ships. */
export function PaneEmpty({ icon, title, hint, children, className }: PaneEmptyProps) {
  return (
    <div
      className={cn(
        "relative flex h-full min-h-48 items-center justify-center overflow-hidden px-6",
        className
      )}
    >
      <div className="relative flex max-w-[16rem] flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="bg-muted text-muted-foreground rounded-lg p-2.5 [&_svg]:size-5"
        >
          {icon}
        </span>
        <div>
          <p className="text-foreground text-sm font-medium">{title}</p>
          {hint ? (
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{hint}</p>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
