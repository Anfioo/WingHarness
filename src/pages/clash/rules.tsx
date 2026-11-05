import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PowerOff, RefreshCw, Route, Search } from "lucide-react";
import { clashRules, type ClashRoutingRule } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { Empty } from "./shared";

/** A rule plus the position the core evaluates it at. */
type IndexedRule = ClashRoutingRule & { lineNo: number };

export function RulesTab({ running }: { running: boolean }) {
  const { t } = useAppTranslation();

  const [rules, setRules] = useState<IndexedRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await clashRules();
      if (!mounted.current) return;
      // Numbered before filtering: the number is the rule's place in the
      // evaluation order, not its row on screen.
      setRules(next.rules.map((rule, index) => ({ ...rule, lineNo: index + 1 })));
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setRules(null);
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rules ?? [];
    return (rules ?? []).filter((rule) => rule.payload.toLowerCase().includes(needle));
  }, [query, rules]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("clash.rules.search")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {t("clash.rules.count", { count: filtered.length })}
        </span>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
          {t("clash.actions.refresh")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <Empty icon={PowerOff} text={running ? error : t("clash.rules.offline")} />
        ) : rules === null ? null : filtered.length === 0 ? (
          <Empty
            icon={Route}
            text={query.trim() ? t("clash.rules.noMatch") : t("clash.rules.empty")}
          />
        ) : (
          <div className="flex flex-col">
            {filtered.map((rule) => (
              <div
                key={rule.lineNo}
                className="flex items-baseline gap-2.5 border-b px-3 py-2 last:border-b-0"
              >
                <span className="text-muted-foreground/60 w-9 shrink-0 text-right font-mono text-[11px] tabular-nums">
                  {rule.lineNo}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm" title={rule.payload || undefined}>
                    {rule.payload || "—"}
                  </div>
                  <div className="text-muted-foreground mt-1 flex items-baseline gap-2 text-xs">
                    <span className="w-24 shrink-0 truncate" title={rule.kind || undefined}>
                      {rule.kind || "—"}
                    </span>
                    <span
                      className={cn("truncate", proxyTone(rule.proxy))}
                      title={rule.proxy || undefined}
                    >
                      {rule.proxy || "—"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A rule that drops traffic, or keeps it local, reads differently from one that picks a group. */
function proxyTone(proxy: string): string {
  const upper = proxy.trim().toUpperCase();
  if (upper.startsWith("REJECT")) return "text-red-600 dark:text-red-400";
  if (upper === "DIRECT") return "text-muted-foreground";
  return "text-emerald-600 dark:text-emerald-400";
}
