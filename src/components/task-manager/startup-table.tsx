import { useAppTranslation } from "@/hooks/use-app-translation";
import type { StartupItem } from "@/commands";
import { StartupContextMenu } from "./startup-context-menu";
import { StartupIcon } from "./startup-icon";
import { StartupStatus } from "./startup-status";

export type StartupSort = "name" | "publisher" | "enabled" | "location";

export function StartupTable({
  items,
  pending,
  sort,
  onSort,
  onToggle,
}: {
  items: StartupItem[];
  pending: ReadonlySet<string>;
  sort: StartupSort;
  onSort: (sort: StartupSort) => void;
  onToggle: (item: StartupItem, enabled: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const columns: { key: StartupSort; label: string }[] = [
    { key: "name", label: t("taskManager.startup.column.name") },
    { key: "publisher", label: t("taskManager.startup.column.publisher") },
    { key: "enabled", label: t("taskManager.startup.column.status") },
    { key: "location", label: t("taskManager.startup.column.location") },
    { key: "location", label: t("taskManager.startup.column.command") },
  ];
  return (
    <div className="border-border bg-card min-h-0 flex-1 overflow-auto rounded-xl border">
      <div className="min-w-[800px]">
        <div className="bg-muted text-muted-foreground grid grid-cols-[minmax(220px,1.5fr)_minmax(120px,1fr)_130px_180px_minmax(240px,2fr)] items-center border-b px-3 py-2 text-xs font-medium">
          {columns.map((column, index) => (
            <button
              key={`${column.label}-${index}`}
              type="button"
              className={sort === column.key ? "text-foreground text-left" : "text-left"}
              onClick={() => onSort(column.key)}
            >
              {column.label}
            </button>
          ))}
        </div>
        {items.map((item) => (
          <StartupContextMenu
            key={item.id}
            item={item}
            onToggle={(enabled) => onToggle(item, enabled)}
          >
            <div className="border-border/60 grid grid-cols-[minmax(220px,1.5fr)_minmax(120px,1fr)_130px_180px_minmax(240px,2fr)] items-center gap-2 border-b px-3 py-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <StartupIcon item={item} />
                <span className="truncate" title={item.name}>
                  {item.name}
                </span>
                {!item.exists && (
                  <span className="text-destructive shrink-0">
                    ({t("taskManager.startup.status.missing")})
                  </span>
                )}
              </div>
              <span className="text-muted-foreground truncate">{item.publisher ?? "—"}</span>
              <StartupStatus
                item={item}
                pending={pending.has(item.id)}
                onChange={(enabled) => onToggle(item, enabled)}
              />
              <span className="truncate" title={t(`taskManager.startup.location.${item.location}`)}>
                {t(`taskManager.startup.location.${item.location}`)}
              </span>
              <span className="text-muted-foreground truncate font-mono" title={item.command}>
                {item.command || "—"}
              </span>
            </div>
          </StartupContextMenu>
        ))}
      </div>
    </div>
  );
}
