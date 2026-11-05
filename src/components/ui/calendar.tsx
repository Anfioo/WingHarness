import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  // Range days have to stay square so the band segments of neighbouring cells
  // join into one strip; the start/end days round their outer side themselves.
  const isRange = props.mode === "range"

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-4",
        month_caption: "flex justify-center pt-1 relative items-center w-full h-8",
        caption_label: "text-sm font-medium",
        nav: "absolute inset-x-1 top-1 flex items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "size-7 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "size-7 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        weeks: "w-full border-collapse space-y-1",
        weekdays: "flex",
        weekday:
          "text-muted-foreground rounded-md w-8 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: cn(
          buttonVariants({ variant: "ghost" }),
          "relative size-8 p-0 font-normal aria-selected:opacity-100",
          "hover:bg-foreground/5 hover:text-foreground",
          isRange ? "rounded-none" : "rounded-full",
        ),
        // Filled ends. The `!` keeps the dark cell on top of every other
        // background a day can carry at the same time: the neutral gray of a
        // `today` inside the range, and the plain hover background.
        selected: "bg-primary! text-primary-foreground!",
        // Start = left half circle, end = right half circle, inner edge left
        // square by the base above. An identical start/end day receives both
        // classes, and since neither side ever sets `none` they add up to a
        // full circle.
        range_start: "rounded-s-full!",
        range_end: "rounded-e-full!",
        // The middle of the band is `selected` too, so the neutral gray has to
        // out-specify the dark fill via the `aria-selected` variant.
        range_middle:
          "aria-selected:bg-foreground/10! aria-selected:text-foreground!",
        today: "bg-foreground/10 font-semibold",
        outside: "text-muted-foreground opacity-50",
        disabled: "text-muted-foreground opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => {
          const Icon = orientation === "left" ? ChevronLeft : ChevronRight
          return <Icon className="size-4" />
        },
      }}
      {...props}
    />
  )
}

export { Calendar }
