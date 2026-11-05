import { ArrowDownUp, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type {
  ApplicationSort,
  ApplicationSortDirection,
  ApplicationSourceFilter,
} from "@/lib/systools/applications";

type UninstallToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  publisher: string;
  onPublisherChange: (value: string) => void;
  publishers: string[];
  source: ApplicationSourceFilter;
  onSourceChange: (value: ApplicationSourceFilter) => void;
  sort: ApplicationSort;
  onSortChange: (value: ApplicationSort) => void;
  direction: ApplicationSortDirection;
  onDirectionToggle: () => void;
  scanning: boolean;
  hasScanned: boolean;
  busy: boolean;
  onScan: () => void;
  onOpenWindowsApps: () => void;
};

const SOURCE_FILTERS: readonly ApplicationSourceFilter[] = ["all", "registry", "store", "winget"];
const SORTS: readonly ApplicationSort[] = ["name", "size", "installDate"];

function isSourceFilter(value: string): value is ApplicationSourceFilter {
  return (SOURCE_FILTERS as readonly string[]).includes(value);
}

function isSort(value: string): value is ApplicationSort {
  return (SORTS as readonly string[]).includes(value);
}

/** Search, facet filters, sorting, and the scan/open actions. */
export function UninstallToolbar({
  query,
  onQueryChange,
  publisher,
  onPublisherChange,
  publishers,
  source,
  onSourceChange,
  sort,
  onSortChange,
  direction,
  onDirectionToggle,
  scanning,
  hasScanned,
  busy,
  onScan,
  onOpenWindowsApps,
}: UninstallToolbarProps) {
  const { t } = useAppTranslation();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <div className="relative w-full min-w-40 sm:w-56">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("systools.uninstall.filters.searchPlaceholder")}
          aria-label={t("systools.uninstall.filters.searchPlaceholder")}
          className="h-8 pl-8"
        />
      </div>

      <Select value={publisher} onValueChange={onPublisherChange}>
        <SelectTrigger
          size="sm"
          className="max-w-44"
          aria-label={t("systools.uninstall.filters.publisher")}
        >
          <SelectValue placeholder={t("systools.uninstall.filters.allPublishers")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("systools.uninstall.filters.allPublishers")}</SelectItem>
          {publishers.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={source}
        onValueChange={(value) => {
          if (isSourceFilter(value)) onSourceChange(value);
        }}
      >
        <SelectTrigger size="sm" aria-label={t("systools.uninstall.filters.source")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("systools.uninstall.filters.sources.all")}</SelectItem>
          <SelectItem value="registry">
            {t("systools.uninstall.filters.sources.registry")}
          </SelectItem>
          <SelectItem value="store">{t("systools.uninstall.filters.sources.store")}</SelectItem>
          <SelectItem value="winget">{t("systools.uninstall.filters.sources.winget")}</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={sort}
        onValueChange={(value) => {
          if (isSort(value)) onSortChange(value);
        }}
      >
        <SelectTrigger size="sm" aria-label={t("systools.uninstall.filters.sort")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="name">{t("systools.uninstall.filters.sortName")}</SelectItem>
          <SelectItem value="size">{t("systools.uninstall.filters.sortSize")}</SelectItem>
          <SelectItem value="installDate">
            {t("systools.uninstall.filters.sortInstallDate")}
          </SelectItem>
        </SelectContent>
      </Select>

      <Button
        variant="outline"
        size="sm"
        onClick={onDirectionToggle}
        aria-label={
          direction === "asc"
            ? t("systools.uninstall.filters.ascending")
            : t("systools.uninstall.filters.descending")
        }
        title={
          direction === "asc"
            ? t("systools.uninstall.filters.ascending")
            : t("systools.uninstall.filters.descending")
        }
      >
        <ArrowDownUp className="size-4" />
        {direction === "asc"
          ? t("systools.uninstall.filters.ascendingShort")
          : t("systools.uninstall.filters.descendingShort")}
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onOpenWindowsApps} disabled={busy}>
          <ExternalLink className="size-4" />
          <span className="hidden sm:inline">
            {t("systools.uninstall.actions.openWindowsApps")}
          </span>
        </Button>
        <Button size="sm" onClick={onScan} disabled={scanning}>
          {scanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {scanning
            ? t("systools.uninstall.actions.scanning")
            : hasScanned
              ? t("systools.uninstall.actions.rescan")
              : t("systools.uninstall.actions.scan")}
        </Button>
      </div>
    </div>
  );
}
