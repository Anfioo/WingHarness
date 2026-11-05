import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type {
  SystemSettingCategory,
  SystemSettingItem,
  SystemSettingTargetState,
} from "@/lib/systools/system-settings";
import { cn } from "@/lib/utils";
import { SettingRow } from "./setting-row";

type CategorySectionProps = {
  category: SystemSettingCategory;
  items: SystemSettingItem[];
  collapsed: boolean;
  busy: boolean;
  pending: ReadonlyMap<string, SystemSettingTargetState>;
  onToggleCollapse: (category: SystemSettingCategory) => void;
  onToggleSetting: (item: SystemSettingItem) => void;
};

/** A collapsible category with its per-category progress summary. */
export function CategorySection({
  category,
  items,
  collapsed,
  busy,
  pending,
  onToggleCollapse,
  onToggleSetting,
}: CategorySectionProps) {
  const { t } = useAppTranslation();

  const optimized = items.filter((item) => item.status === "optimized").length;
  const unavailable = items.filter((item) => item.status === "unavailable").length;

  return (
    <section className="rounded-lg border">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onToggleCollapse(category)}
        className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors"
      >
        <ChevronDown
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            collapsed && "-rotate-90"
          )}
        />
        <span className="text-sm font-medium">{t(`systools.optimize.categories.${category}`)}</span>
        <span className="text-muted-foreground text-xs">
          {t("systools.optimize.categorySummary", { optimized, total: items.length })}
        </span>
        {unavailable > 0 && (
          <Badge variant="outline" className="text-muted-foreground text-[10px]">
            {t("systools.optimize.status.unavailable")} · {unavailable}
          </Badge>
        )}
      </button>

      {!collapsed &&
        (items.length > 0 ? (
          <ul className="divide-y border-t">
            {items.map((item) => (
              <SettingRow
                key={item.settingId}
                item={item}
                pendingTarget={pending.get(item.settingId)}
                busy={busy}
                onToggle={() => onToggleSetting(item)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground border-t px-3 py-2 text-xs">
            {t("systools.common.empty")}
          </p>
        ))}
    </section>
  );
}
