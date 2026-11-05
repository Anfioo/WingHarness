import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface EmptyPaneProps {
  /** Optional icon, rendered inside a muted circle above the title. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional call to action, e.g. a `<Button>`. */
  action?: ReactNode;
  className?: string;
}

/**
 * A centred empty state that fills its parent. Reusable across the API client
 * panes: pass an icon, a title and (usually) a short description, plus an
 * action node when there is something the user can do about it.
 */
export function EmptyPane({
  icon,
  title,
  description,
  action,
  className,
}: EmptyPaneProps): ReactNode {
  return (
    <div
      data-slot="empty-pane"
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center",
        className
      )}
    >
      {icon ? (
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="text-muted-foreground max-w-xs text-xs">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export default EmptyPane;
