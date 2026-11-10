// The ports page toolbar: search, grouping, the three-state filter, refresh and
// the last-updated hint.

import { useEffect, useRef } from "react";
import { RefreshCw, Search, X } from "lucide-react";
import type { PortGrouping, PortStatus } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import type { PortsToolbarProps } from "./props";

const STATUS_ORDER: PortStatus[] = ["free", "occupied", "system"];

const GROUP_ORDER: { value: PortGrouping; labelKey: string }[] = [
  { value: "port", labelKey: "ports.toolbar.groupPort" },
  { value: "app", labelKey: "ports.toolbar.groupApp" },
];

const STATUS_DOT: Record<PortStatus, string> = {
  free: "bg-emerald-500",
  occupied: "bg-amber-500",
  system: "bg-slate-400",
};

const STATUS_RING: Record<PortStatus, string> = {
  free: "border-emerald-500",
  occupied: "border-amber-500",
  system: "border-slate-400",
};

const STATUS_LABEL_KEY: Record<PortStatus, string> = {
  free: "ports.status.free",
  occupied: "ports.status.occupied",
  system: "ports.status.system",
};

export function PortsToolbar({
  query,
  onQueryChange,
  statuses,
  onToggleStatus,
  groupBy,
  onGroupingChange,
  refreshing,
  updatedAt,
  paused,
  onRefresh,
}: PortsToolbarProps) {
  const { t, language } = useAppTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere on the page, except while typing elsewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      )
        return;

      event.preventDefault();
      inputRef.current?.focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const updatedTime = updatedAt === 0 ? null : new Date(updatedAt).toLocaleTimeString(language);
  const statusHint = paused
    ? t("ports.toolbar.paused")
    : updatedTime === null
      ? t("ports.toolbar.refreshing")
      : t("ports.toolbar.updated", { time: updatedTime });
  const updatedTitle = updatedAt === 0 ? undefined : new Date(updatedAt).toLocaleString(language);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="group relative min-w-[12rem] flex-1">
        <Search className="text-muted-foreground group-focus-within:text-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 transition-colors" />
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            onQueryChange("");
            inputRef.current?.blur();
          }}
          placeholder={t("ports.toolbar.searchPlaceholder")}
          aria-label={t("ports.toolbar.searchAria")}
          className="pr-10 pl-9 font-mono tabular-nums"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            aria-label={t("ports.toolbar.clearSearch")}
            className="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded"
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <kbd className="text-muted-foreground border-border pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border px-1.5 font-mono text-[10px] leading-4 transition-opacity group-focus-within:opacity-0">
            /
          </kbd>
        )}
      </div>

      <div
        role="group"
        aria-label={t("ports.toolbar.groupAria")}
        className="border-border bg-card flex h-9 shrink-0 items-center gap-0.5 rounded-lg border p-[3px]"
      >
        {GROUP_ORDER.map((option) => {
          const active = groupBy === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onGroupingChange(option.value)}
              className={cn(
                "focus-visible:ring-ring/50 flex h-full items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-hidden",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>

      <div
        role="group"
        aria-label={t("ports.toolbar.filterAria")}
        className="border-border bg-card flex h-9 shrink-0 items-center gap-0.5 rounded-lg border p-[3px]"
      >
        {STATUS_ORDER.map((status) => {
          const active = statuses.has(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() => onToggleStatus(status)}
              className={cn(
                "focus-visible:ring-ring/50 flex h-full items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-hidden",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full border transition-colors",
                  STATUS_RING[status],
                  active ? STATUS_DOT[status] : "bg-transparent"
                )}
              />
              {t(STATUS_LABEL_KEY[status])}
            </button>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span
          aria-live="polite"
          title={updatedTitle}
          className="text-muted-foreground text-xs whitespace-nowrap"
        >
          {statusHint}
        </span>
        <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          {t("ports.actions.refresh")}
        </Button>
      </div>
    </div>
  );
}
