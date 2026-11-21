// The connections toolbar: the filter segments, the search box, the live
// counts and a manual refresh.

import { RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ConnectionFilter, ConnectionStats } from "@/hooks/use-task-manager-connections";
import { cn } from "@/lib/utils";

const FILTERS: ConnectionFilter[] = ["all", "listen", "established", "udp"];

export function ConnectionsToolbar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  onRefresh,
  loading,
  stats,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  filter: ConnectionFilter;
  onFilterChange: (filter: ConnectionFilter) => void;
  onRefresh: () => void;
  loading: boolean;
  stats: ConnectionStats;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label={t("taskManager.connections.title")}
        className="bg-muted/70 flex items-center gap-0.5 rounded-lg p-0.5"
      >
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => onFilterChange(value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition-colors",
              filter === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t(`taskManager.connections.filter.${value}`)}
          </button>
        ))}
      </div>

      <div className="relative min-w-48 flex-1">
        <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("taskManager.connections.search.placeholder")}
          aria-label={t("taskManager.connections.search.aria")}
          className="pr-8 pl-8"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label={t("taskManager.connections.search.clear")}
            className="text-muted-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>{t("taskManager.connections.summary.listening", { count: stats.listening })}</span>
        <span aria-hidden>·</span>
        <span>
          {t("taskManager.connections.summary.established", { count: stats.established })}
        </span>
        <span aria-hidden>·</span>
        <span>{t("taskManager.connections.summary.udp", { count: stats.udp })}</span>
        <span aria-hidden>·</span>
        <span>{t("taskManager.connections.summary.total", { count: stats.total })}</span>
      </div>

      <Button
        variant="outline"
        size="icon"
        onClick={onRefresh}
        aria-label={t("taskManager.actions.refresh")}
      >
        <RefreshCw className={cn("size-4", loading && "animate-spin")} />
      </Button>
    </div>
  );
}
