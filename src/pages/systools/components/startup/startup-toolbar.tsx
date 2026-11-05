import { Loader2, RefreshCw, Search, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { STARTUP_SOURCE_FILTERS, type StartupSourceFilter } from "@/lib/systools/startup";
import { cn } from "@/lib/utils";
import { startupFilterLabelKey } from "./startup-labels";

type StartupToolbarProps = {
  filter: StartupSourceFilter;
  onFilterChange: (filter: StartupSourceFilter) => void;
  counts: Record<StartupSourceFilter, number>;
  query: string;
  onQueryChange: (query: string) => void;
  scanning: boolean;
  cancellingScan: boolean;
  hasCatalog: boolean;
  /** True while a change plan is being prepared or applied. */
  busy: boolean;
  onScan: () => void;
  onCancelScan: () => void;
};

/** Source facet counts, search, and the scan actions. */
export function StartupToolbar({
  filter,
  onFilterChange,
  counts,
  query,
  onQueryChange,
  scanning,
  cancellingScan,
  hasCatalog,
  busy,
  onScan,
  onCancelScan,
}: StartupToolbarProps) {
  const { t } = useAppTranslation();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <div className="relative w-full min-w-40 sm:w-52">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("systools.startup.searchPlaceholder")}
          aria-label={t("systools.startup.searchPlaceholder")}
          className="h-8 pl-8"
        />
      </div>

      <nav
        aria-label={t("systools.startup.title")}
        className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5"
      >
        {STARTUP_SOURCE_FILTERS.map((value) => {
          const active = value === filter;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(value)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span>{t(startupFilterLabelKey(value))}</span>
              <span className="text-muted-foreground tabular-nums">{counts[value]}</span>
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {scanning && (
          <Button variant="outline" size="sm" onClick={onCancelScan} disabled={cancellingScan}>
            <XCircle className="size-4" />
            {cancellingScan ? t("systools.common.cancel") : t("systools.startup.cancelScan")}
          </Button>
        )}
        <Button size="sm" onClick={onScan} disabled={scanning || busy}>
          {scanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {scanning
            ? t("systools.startup.scanning")
            : hasCatalog
              ? t("systools.startup.rescan")
              : t("systools.startup.scan")}
        </Button>
      </div>
    </div>
  );
}
