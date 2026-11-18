// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The processes tab toolbar: the three views, search, sorting, pause and
// refresh, plus the hint that some columns and actions need the service.

import { useEffect, useRef } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Info,
  LayoutGrid,
  List,
  ListTree,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  SORT_DESC_FIRST,
  SORT_KEYS,
  type ProcessSort,
  type ProcessSortKey,
  type ProcessView,
} from "@/lib/task-manager/process-sections";
import { cn } from "@/lib/utils";

const VIEWS: { view: ProcessView; icon: typeof LayoutGrid; labelKey: string }[] = [
  { view: "apps", icon: LayoutGrid, labelKey: "taskManager.process.view.apps" },
  { view: "tree", icon: ListTree, labelKey: "taskManager.process.view.tree" },
  { view: "list", icon: List, labelKey: "taskManager.process.view.list" },
];

export type ProcessToolbarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  view: ProcessView;
  onViewChange: (view: ProcessView) => void;
  sort: ProcessSort;
  onSortChange: (sort: ProcessSort) => void;
  paused: boolean;
  onTogglePaused: () => void;
  onRefresh: () => void;
  processCount: number;
  serviceReady: boolean;
};

export function ProcessToolbar({
  query,
  onQueryChange,
  view,
  onViewChange,
  sort,
  onSortChange,
  paused,
  onTogglePaused,
  onRefresh,
  processCount,
  serviceReady,
}: ProcessToolbarProps) {
  const { t } = useAppTranslation();
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
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex flex-col gap-2">
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
            placeholder={t("taskManager.process.search.placeholder")}
            aria-label={t("taskManager.process.search.aria")}
            className="pr-10 pl-9"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                onQueryChange("");
                inputRef.current?.focus();
              }}
              aria-label={t("taskManager.process.search.clear")}
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
          aria-label={t("taskManager.process.view.label")}
          className="border-border bg-card flex h-9 shrink-0 items-center gap-0.5 rounded-lg border p-[3px]"
        >
          {VIEWS.map((option) => {
            const Icon = option.icon;
            const active = view === option.view;
            return (
              <button
                key={option.view}
                type="button"
                aria-pressed={active}
                title={t(option.labelKey)}
                onClick={() => onViewChange(option.view)}
                className={cn(
                  "focus-visible:ring-ring/50 flex h-full items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-hidden",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">{t(option.labelKey)}</span>
              </button>
            );
          })}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0">
              <ArrowUpDown />
              {t(`taskManager.process.sort.key.${sort.key}`)}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>{t("taskManager.process.sort.label")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort.key}
              onValueChange={(value) => {
                const key = value as ProcessSortKey;
                onSortChange({ key, desc: SORT_DESC_FIRST[key] });
              }}
            >
              {SORT_KEYS.map((key) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {t(`taskManager.process.sort.key.${key}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onSortChange({ ...sort, desc: !sort.desc })}>
              {sort.desc ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
              {t(
                sort.desc
                  ? "taskManager.process.sort.descending"
                  : "taskManager.process.sort.ascending"
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          size="icon"
          aria-label={t(paused ? "taskManager.process.resume" : "taskManager.process.pause")}
          title={t(paused ? "taskManager.process.resume" : "taskManager.process.pause")}
          aria-pressed={paused}
          onClick={onTogglePaused}
        >
          {paused ? <Play /> : <Pause />}
        </Button>

        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw />
          {t("taskManager.actions.refresh")}
        </Button>

        <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap tabular-nums">
          {t("taskManager.process.count", { count: processCount })}
        </span>
      </div>

      {!serviceReady && (
        <div className="text-muted-foreground flex items-start gap-2 rounded-lg border border-dashed px-3 py-1.5 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t("taskManager.process.serviceHint")}</span>
        </div>
      )}
    </div>
  );
}
