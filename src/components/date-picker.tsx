import * as React from "react";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** "YYYY-MM-DD" -> local Date, no time zone shift (matches a native date input). */
function parseISODate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Date -> "YYYY-MM-DD". */
function toISODate(d: Date | undefined): string {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Day index in local time, ignoring the time of day. Built from the calendar
 * fields through `Date.UTC`, so a DST shift can never merge two days.
 */
function dayNumber(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}

/**
 * Classes for the range modifiers computed in `DateRangePicker` below. They all
 * carry `!` so the band and its ends outrank the plain hover background.
 */
const RANGE_CLASS_NAMES = {
  // Only the start is picked: it already reads as the left half circle.
  rangeStartPending: "rounded-s-full!",
  // Days the pointer swept over while the end is still missing.
  rangePreview: "bg-foreground/10! text-foreground!",
  // The hovered day stands in for the end, so it borrows its outer rounding.
  rangePreviewTipStart: "bg-foreground/10! text-foreground! rounded-s-full!",
  rangePreviewTipEnd: "bg-foreground/10! text-foreground! rounded-e-full!",
};

export function DatePicker({
  value,
  onChange,
  placeholder = "选择日期",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = parseISODate(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 w-36 justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="size-4" />
          {value || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(d) => {
            onChange(toISODate(d));
            setOpen(false);
          }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

export function DateRangePicker({
  from,
  to,
  onChange,
  placeholder = "选择日期范围",
  className,
}: {
  from: string;
  to: string;
  onChange: (v: { from: string; to: string }) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState<Date | undefined>(undefined);

  const fromDate = React.useMemo(() => parseISODate(from), [from]);
  const toDate = React.useMemo(() => parseISODate(to), [to]);

  const selected = React.useMemo<DateRange | undefined>(
    () => (fromDate || toDate ? { from: fromDate, to: toDate } : undefined),
    [fromDate, toDate]
  );

  // With only the start picked the range is still open, so the calendar cannot
  // tell where it ends. Follow the pointer and pre-render the span the second
  // click would produce, with the hovered day standing in for the end.
  const rangeModifiers = React.useMemo(() => {
    if (!fromDate || toDate) return undefined;

    const start = dayNumber(fromDate);
    // Only the start is picked: it already reads as the left half circle.
    const modifiers: Record<string, (d: Date) => boolean> = {
      rangeStartPending: (d) => dayNumber(d) === start,
    };

    if (hovered) {
      const hover = dayNumber(hovered);
      if (hover !== start) {
        const lo = Math.min(start, hover);
        const hi = Math.max(start, hover);
        // Only the days strictly between the ends: the start is already filled
        // and the hovered day is drawn by one of the tip modifiers below.
        modifiers.rangePreview = (d) => {
          const n = dayNumber(d);
          return n > lo && n < hi;
        };
        modifiers[hover < start ? "rangePreviewTipStart" : "rangePreviewTipEnd"] = (d) =>
          dayNumber(d) === hover;
      }
    }

    return modifiers;
  }, [fromDate, toDate, hovered]);

  const label = from && to ? `${from} ~ ${to}` : from ? `${from} ~ …` : to ? `… ~ ${to}` : "";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setHovered(undefined);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 w-56 justify-start text-left font-normal",
            !label && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="size-4" />
          {label || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0"
        align="start"
        // The preview must not outlive the pointer leaving the calendar.
        onMouseLeave={() => setHovered(undefined)}
      >
        <Calendar
          mode="range"
          // react-day-picker 9.14 made the reset opt-in: without it the very
          // first click already returns a complete `from === to` range, so the
          // popover would close after a single day instead of waiting for the
          // end. With it the first click only sets the pending start.
          resetOnSelect
          selected={selected}
          modifiers={rangeModifiers}
          modifiersClassNames={RANGE_CLASS_NAMES}
          onDayMouseEnter={(date) => setHovered(date)}
          onSelect={(range) => {
            onChange({ from: toISODate(range?.from), to: toISODate(range?.to) });
            // Keep the popover open while only the start is set, so the second
            // click closes the pending end.
            if (range?.from && range.to) {
              setHovered(undefined);
              setOpen(false);
            }
          }}
          initialFocus
          numberOfMonths={1}
        />
      </PopoverContent>
    </Popover>
  );
}
