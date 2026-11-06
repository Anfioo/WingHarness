import { X } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { tabKey, useDatabaseTabs } from "./window-tabs";

/**
 * The tab strip of a data source window. The console is first and has no close
 * button; every other tab is a table and closes with `×`.
 */
export function TabBar() {
  const { t } = useAppTranslation();
  const { tabs, active, select, close } = useDatabaseTabs();

  return (
    <div className="bg-muted/40 flex shrink-0 items-stretch gap-1 overflow-x-auto border-b px-1 py-1">
      {tabs.map((tab) => {
        const key = tabKey(tab);
        const current = key === active;
        const label =
          tab.kind === "console" ? t("database.tab.console") : `${tab.schema}.${tab.table}`;

        return (
          <div
            key={key}
            className={cn(
              "flex shrink-0 items-center rounded-md text-xs",
              current ? "bg-background shadow-sm" : "hover:bg-accent/60"
            )}
          >
            <button
              type="button"
              className="max-w-56 truncate px-2 py-1 text-left"
              title={label}
              onClick={() => select(key)}
            >
              {label}
            </button>
            {tab.kind === "table" && (
              <button
                type="button"
                className="hover:bg-accent mr-1 rounded-sm p-1"
                aria-label={t("database.tab.close")}
                title={t("database.tab.close")}
                onClick={() => close(key)}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
