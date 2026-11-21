import { useMemo, useState } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManagerStartup } from "@/hooks/use-task-manager-startup";
import { StartupTable } from "@/components/task-manager/startup-table";
import { StartupToolbar } from "@/components/task-manager/startup-toolbar";
import {
  filterStartupItems,
  sortStartupItems,
  type StartupSort,
} from "@/lib/task-manager/startup-rows";

export function StartupTab() {
  const { t } = useAppTranslation();
  const { items, loading, error, pending, load, setEnabled } = useTaskManagerStartup();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<StartupSort>("name");
  const filtered = useMemo(
    () => sortStartupItems(filterStartupItems(items, query), sort),
    [items, query, sort]
  );
  const enabled = items.filter((item) => item.enabled).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <StartupToolbar
        query={query}
        onQueryChange={setQuery}
        onRefresh={() => void load()}
        total={items.length}
        enabled={enabled}
      />
      {loading && items.length === 0 ? (
        <div className="border-border bg-card flex min-h-0 flex-1 flex-col gap-3 rounded-xl border p-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : error && items.length === 0 ? (
        <div className="border-border bg-card flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border text-center">
          <AlertCircle className="text-destructive size-6" />
          <p className="text-sm font-medium">{t("taskManager.startup.empty.none")}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("taskManager.actions.refresh")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="border-border bg-card flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border text-center">
          <p className="text-sm font-medium">
            {items.length === 0
              ? t("taskManager.startup.empty.none")
              : t("taskManager.startup.empty.noMatch")}
          </p>
          {query && (
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              {t("taskManager.startup.empty.clear")}
            </Button>
          )}
        </div>
      ) : (
        <StartupTable
          items={filtered}
          pending={pending}
          sort={sort}
          onSort={setSort}
          onToggle={(item, value) => void setEnabled(item, value)}
        />
      )}
      {loading && items.length > 0 && (
        <LoaderCircle className="text-muted-foreground mx-auto size-4 animate-spin" />
      )}
    </div>
  );
}
