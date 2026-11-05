import { cn } from "@/lib/utils";

export type StatChip = {
  key: string;
  label: string;
  value: string;
  /** Secondary line under the value, e.g. the total a part refers to. */
  hint?: string;
  tone?: "default" | "warning";
};

export type StatChipsProps = {
  items: StatChip[];
};

/** The overview's four at-a-glance counters. */
export function StatChips({ items }: StatChipsProps) {
  return (
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.key}
          className={cn(
            "border-border bg-card rounded-lg border px-3 py-2",
            item.tone === "warning" && "border-destructive/40 bg-destructive/5"
          )}
        >
          <dt className="text-muted-foreground truncate text-xs">{item.label}</dt>
          <dd
            className={cn(
              "text-foreground mt-0.5 text-lg leading-tight font-semibold tabular-nums",
              item.tone === "warning" && "text-destructive"
            )}
          >
            {item.value}
          </dd>
          {item.hint && <p className="text-muted-foreground truncate text-[11px]">{item.hint}</p>}
        </div>
      ))}
    </dl>
  );
}
