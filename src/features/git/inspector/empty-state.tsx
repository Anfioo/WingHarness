export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="border-border bg-muted/40 flex flex-col items-start gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center">
      <span className="bg-primary/15 text-primary flex size-9 shrink-0 items-center justify-center rounded-md">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      </div>
      {action}
    </div>
  );
}
