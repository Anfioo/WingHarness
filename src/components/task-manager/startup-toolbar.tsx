import { RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";

export function StartupToolbar({
  query,
  onQueryChange,
  onRefresh,
  total,
  enabled,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  total: number;
  enabled: number;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-48 flex-1">
        <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("taskManager.startup.search.placeholder")}
          aria-label={t("taskManager.startup.search.aria")}
          className="pr-8 pl-8"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label={t("taskManager.startup.search.clear")}
            className="text-muted-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <span className="text-muted-foreground text-xs">
        {t("taskManager.startup.summary", { enabled, total })}
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={onRefresh}
        aria-label={t("taskManager.actions.refresh")}
      >
        <RefreshCw className="size-4" />
      </Button>
    </div>
  );
}
