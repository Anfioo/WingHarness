import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { cn } from "@/lib/utils";
import { ScoopTerminal } from "./scoop-terminal";

/**
 * The bottom dock: the step log, the exact script about to run, and the
 * terminal it runs in. It sits outside the tab panels so switching tabs never
 * unmounts a running session.
 */
export function ScoopRunDock({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const [showScript, setShowScript] = useState(false);

  if (!page.plan && page.logs.length === 0) return null;

  const state =
    page.running !== null
      ? "running"
      : page.lastExit === 0
        ? "ok"
        : page.lastExit === null
          ? "idle"
          : "failed";

  return (
    <section className="border-border bg-card/60 shrink-0 rounded-xl border">
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium">{t("scoop.run.title")}</span>
        <Badge
          variant={state === "failed" ? "destructive" : state === "ok" ? "default" : "secondary"}
        >
          {t(`scoop.run.state.${state}`)}
        </Badge>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
          {page.plan?.scriptPath}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setShowScript((value) => !value)}>
          {showScript ? t("scoop.run.hideCommand") : t("scoop.run.showCommand")}
        </Button>
        <Button variant="ghost" size="sm" disabled={page.running !== null} onClick={page.clearRun}>
          {t("scoop.run.clear")}
        </Button>
      </header>

      {showScript && page.plan && (
        <div className="space-y-1 px-3 pb-2">
          <pre className="bg-background max-h-40 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
            {page.plan.script}
          </pre>
          <p className="text-muted-foreground text-[11px]">{t("scoop.run.envHint")}</p>
        </div>
      )}

      <div className="grid gap-3 px-3 pb-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="border-border bg-background/60 h-64 overflow-auto rounded-lg border p-2 font-mono text-[11px] leading-relaxed">
          {page.logs.map((line) => (
            <div
              key={line.id}
              className={cn(
                line.tone === "error" && "text-destructive",
                line.tone === "done" && "text-emerald-600 dark:text-emerald-400"
              )}
            >
              {line.text}
            </div>
          ))}
        </div>
        <ScoopTerminal run={page.run} onExit={page.onRunExit} />
      </div>
    </section>
  );
}
