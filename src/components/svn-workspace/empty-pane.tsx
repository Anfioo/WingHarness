import type { ReactNode } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The empty and loading presentations shared by the working-copy views, built
 * from the reference's `GlassLoading.vue`: a centred indicator for loading and
 * a compact icon + copy block for "nothing here". `loading` selects which one
 * is shown, so callers never render two states at once.
 */
export function EmptyPane({
  icon: Icon,
  title,
  description,
  loading,
  className,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  loading?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3",
          className
        )}
      >
        <span className="relative grid size-11 place-items-center">
          <span className="bg-primary/15 absolute inset-0 animate-ping rounded-full" />
          <span className="border-primary/30 absolute inset-0 rounded-full border" />
          <Loader2 className="text-primary size-5 animate-spin" />
        </span>
        <span className="text-sm">{title}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center",
        className
      )}
    >
      {Icon ? (
        <span className="bg-muted text-muted-foreground mb-1 grid size-12 place-items-center rounded-xl">
          <Icon className="size-6" />
        </span>
      ) : null}
      <p className="text-foreground text-sm font-medium">{title}</p>
      {description ? <p className="text-muted-foreground max-w-sm text-xs">{description}</p> : null}
      {children ? <div className="mt-3 flex items-center gap-2">{children}</div> : null}
    </div>
  );
}
