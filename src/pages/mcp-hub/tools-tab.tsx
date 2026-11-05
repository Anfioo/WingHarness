import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { mcphubListTools, mcphubSetToolEnabled, type ToolView } from "@/commands";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { Switch } from "./ui-bits";

export function ToolsTab() {
  const { t } = useAppTranslation();
  const [tools, setTools] = useState<ToolView[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await mcphubListTools();
      setTools(list);
    } catch (error) {
      console.error("mcphub list tools:", error);
      toast.error(t("mcphub.tools.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (tool) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q)
    );
  }, [tools, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ToolView[]>();
    for (const tool of filtered) {
      const list = map.get(tool.server) ?? [];
      list.push(tool);
      map.set(tool.server, list);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const handleToggle = async (tool: ToolView, next: boolean) => {
    try {
      await mcphubSetToolEnabled(tool.server, tool.name, next);
      setTools((prev) =>
        prev.map((t) =>
          t.server === tool.server && t.name === tool.name ? { ...t, enabled: next } : t
        )
      );
    } catch (error) {
      console.error("mcphub set tool enabled:", error);
      toast.error(t("mcphub.tools.toggleFailed"));
    }
  };

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t("mcphub.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          className="pl-8"
          placeholder={t("mcphub.tools.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {grouped.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center text-sm">
          <p className="text-muted-foreground">{t("mcphub.tools.empty")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {grouped.map(([server, list]) => {
            const isCollapsed = !!collapsed[server];
            return (
              <div key={server} className="border-border overflow-hidden rounded-lg border">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [server]: !c[server] }))}
                  className="bg-muted/40 hover:bg-muted/60 flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                >
                  <ChevronDown
                    className={cn("size-4 transition-transform", isCollapsed && "-rotate-90")}
                  />
                  <span className="font-medium">{server}</span>
                  <span className="text-muted-foreground text-xs">({list.length})</span>
                </button>
                {!isCollapsed && (
                  <div className="divide-border divide-y">
                    {list.map((tool) => (
                      <div
                        key={`${tool.server}/${tool.name}`}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-sm">{tool.name}</div>
                          <div className="text-muted-foreground truncate text-xs">
                            {tool.description}
                          </div>
                        </div>
                        <span className="text-muted-foreground hidden text-xs sm:inline">
                          {tool.enabled ? t("mcphub.tools.enabled") : t("mcphub.tools.disabled")}
                        </span>
                        <Switch
                          checked={tool.enabled}
                          onChange={(next) => void handleToggle(tool, next)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
