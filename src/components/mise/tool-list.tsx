// The left column of the tools tab: a searchable list of installed tools.
// It only renders the props it is given; loading, selection and actions belong
// to the tab's hook.

import { RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { MiseErrorCode, MiseTool } from "@/commands";
import { StatusBadge } from "@/components/mise/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { miseErrorKey } from "@/lib/mise/error-key";
import { cn } from "@/lib/utils";

export type ToolListProps = {
  tools: MiseTool[];
  loading: boolean;
  error: MiseErrorCode | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

export function ToolList({
  tools,
  loading,
  error,
  selectedId,
  onSelect,
  onRefresh,
}: ToolListProps) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...tools].sort((left, right) =>
      (left.name || left.id).localeCompare(right.name || right.id)
    );
    if (!needle) return sorted;
    return sorted.filter(
      (tool) => tool.id.toLowerCase().includes(needle) || tool.name.toLowerCase().includes(needle)
    );
  }, [tools, query]);

  const showSkeleton = loading && tools.length === 0;
  const showError = error !== null && tools.length === 0;

  return (
    <section className="border-border bg-card flex min-h-0 flex-col overflow-hidden rounded-xl border">
      <header className="border-border flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <h2 className="text-sm font-medium">{t("mise.tools.listTitle")}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("mise.actions.refresh")}
          title={t("mise.actions.refresh")}
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </header>

      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("mise.tools.searchPlaceholder")}
            aria-label={t("mise.tools.searchPlaceholder")}
            className="pl-8"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {showSkeleton ? (
          <div className="flex flex-col gap-2 p-1">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="flex flex-col gap-1.5 rounded-lg px-2 py-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        ) : showError && error ? (
          <div className="text-destructive flex flex-col gap-2 rounded-lg px-2 py-3 text-xs">
            <span className="break-words">{t(miseErrorKey(error))}</span>
            <Button variant="outline" size="xs" className="w-fit" onClick={onRefresh}>
              {t("mise.tools.retry")}
            </Button>
          </div>
        ) : tools.length === 0 ? (
          <div className="text-muted-foreground flex flex-col gap-1 px-2 py-6 text-center text-xs">
            <span className="text-foreground text-sm">{t("mise.tools.empty")}</span>
            <span>{t("mise.tools.emptyHint")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground px-2 py-6 text-center text-xs">
            {t("mise.tools.noMatch")}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((tool) => {
              const selected = tool.id === selectedId;
              return (
                <li key={tool.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(tool.id)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50 focus-visible:bg-accent/50"
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-sm font-medium">{tool.name || tool.id}</span>
                        {tool.name !== tool.id && (
                          <span className="text-muted-foreground truncate font-mono text-[11px]">
                            {tool.id}
                          </span>
                        )}
                      </div>
                      <span className="text-muted-foreground text-xs">
                        {t("mise.tools.activeVersion")}:{" "}
                        <span className="font-mono">
                          {tool.activeVersion || t("mise.common.unknown")}
                        </span>
                      </span>
                    </div>
                    <StatusBadge level={tool.level} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
