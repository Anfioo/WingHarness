import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type PromptState = {
  title: string;
  value: string;
  multiline?: boolean;
  onSubmit: (value: string) => void;
};

/** Size in the unit a person would read: `12.4 MB`, `820 KB`, `96 B`. */
export function formatBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes are whole; a rate computed over a fractional interval is not, and
  // printing that raw would show `78.20136852394917 B`.
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Time constant of the displayed speed's moving average, in seconds. */
const RATE_SMOOTHING_SECONDS = 1.5;

/**
 * Byte rates come from differencing cumulative counters once a second, so a
 * bursty transfer makes the raw figure leap between near-zero and megabytes.
 * An exponential moving average keeps the readout and its chart readable while
 * still following a real change within a few seconds.
 */
export function smoothRate(previous: number, next: number, seconds: number): number {
  const weight = 1 - Math.exp(-seconds / RATE_SMOOTHING_SECONDS);
  return previous + (next - previous) * weight;
}

/**
 * Rounds a rate up to the next readable step — 1, 2 or 5 in binary units — so
 * an axis label stays a round number and small wobbles do not rescale a plot.
 */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  let unit = 1;
  while (value >= unit * 1024 && unit < 1024 ** 3) unit *= 1024;
  const scaled = value / unit;
  const magnitude = 10 ** Math.floor(Math.log10(scaled));
  const ratio = scaled / magnitude;
  const step = ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10;
  return Math.max(1, step * magnitude * unit);
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="bg-muted flex shrink-0 items-center gap-0.5 rounded-md p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2.5 py-1 text-xs transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function Empty({ icon: Icon, text }: { icon?: LucideIcon; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
      {Icon && (
        <span className="bg-muted/70 text-muted-foreground/80 flex size-10 items-center justify-center rounded-full">
          <Icon className="size-4" />
        </span>
      )}
      <p className="text-muted-foreground max-w-80 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

export function PromptDialog({
  state,
  labels,
  onChange,
  onClose,
  onConfirm,
}: {
  state: PromptState | null;
  labels: { confirm: string; cancel: string };
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.title ?? ""}</DialogTitle>
        </DialogHeader>
        {state?.multiline ? (
          <textarea
            className="h-48 w-full resize-none rounded-md border bg-transparent p-2.5 font-mono text-sm"
            value={state.value}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <Input
            autoFocus
            value={state?.value ?? ""}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onConfirm()}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button onClick={onConfirm}>{labels.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
