import { cn } from "@/lib/utils";

/** Minimal switch built on native button + tailwind; no shadcn switch installed. */
export function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-white shadow ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

type BadgeTone = "green" | "gray" | "amber" | "red" | "blue";

const toneClass: Record<BadgeTone, string> = {
  green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  gray: "bg-muted text-muted-foreground",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  red: "bg-destructive/15 text-destructive",
  blue: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        toneClass[tone]
      )}
    >
      {children}
    </span>
  );
}
