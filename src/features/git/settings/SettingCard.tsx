import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">
        {label}
        {hint && <span className="text-muted-foreground/70 ml-1.5 font-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function SettingCard({
  title,
  description,
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("border-border bg-card rounded-lg border p-4", className)}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && <p className="text-muted-foreground/70 mt-0.5 text-xs">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

export function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-1">
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{title}</span>
        {description && (
          <span className="text-muted-foreground/70 block text-xs">{description}</span>
        )}
      </span>
      {control}
    </label>
  );
}

export function SettingEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border bg-muted/40 flex flex-col items-center gap-2 rounded-lg border border-dashed p-4 text-center">
      <span className="bg-primary/15 text-primary flex size-9 items-center justify-center rounded-md">
        {icon}
      </span>
      <span className="text-sm font-medium">{title}</span>
      {description && <span className="text-muted-foreground text-xs">{description}</span>}
      {action}
    </div>
  );
}
