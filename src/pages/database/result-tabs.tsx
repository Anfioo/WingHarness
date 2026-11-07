// The result area of one query tab: the output console and one tab per
// statement that produced a result or a plan. The store owns every piece of
// state here; this component only chooses what to render.

import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, Code2, Info, Table2, X } from "lucide-react";
import { toast } from "sonner";
import { databaseErrorCode, dbExplain } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { PlanView } from "./plan-view";
import { bindResultActions, rerunResult } from "./result-actions";
import { ResultView } from "./result-view.tsx";
import { useDatabaseStore, type OutputLine, type ResultTab } from "./store";

export type ResultTabsProps = {
  /** The query tab's key. Not `key`: React would consume that name. */
  tabKey: string;
  sourceId: string;
  target: string;
};

const NO_RESULTS: ResultTab[] = [];
const NO_OUTPUT: OutputLine[] = [];

export function ResultTabs(props: ResultTabsProps): ReactNode {
  const { tabKey, sourceId, target } = props;
  const { t } = useAppTranslation();

  const results = useDatabaseStore((state) => state.results[tabKey]) ?? NO_RESULTS;
  const outputs = useDatabaseStore((state) => state.outputs[tabKey]) ?? NO_OUTPUT;
  const active = useDatabaseStore((state) => state.activeResult[tabKey]);
  const setActiveResult = useDatabaseStore((state) => state.setActiveResult);
  const removeResult = useDatabaseStore((state) => state.removeResult);
  const patchResult = useDatabaseStore((state) => state.patchResult);

  // The rerun / paging actions live outside React and read the current list
  // through this ref; the store itself is only reachable from a component.
  const resultsRef = useRef(results);
  useEffect(() => {
    resultsRef.current = results;
  });
  useEffect(() => {
    bindResultActions({
      sourceId,
      result: (key, id) =>
        key === tabKey ? resultsRef.current.find((result) => result.id === id) : undefined,
      patch: (key, id, patch) => {
        if (key === tabKey) patchResult(key, id, patch);
      },
    });
    return () => bindResultActions(null);
  }, [sourceId, tabKey, patchResult]);

  // A statement without a result set only reaches the output console.
  const shown: Array<{ tab: ResultTab; label: string }> = [];
  let resultNo = 0;
  let planNo = 0;
  for (const tab of results) {
    if (tab.plan !== null) {
      planNo += 1;
      shown.push({ tab, label: `${t("database.result.plan")} ${planNo}` });
    } else if (tab.outcome?.result) {
      resultNo += 1;
      shown.push({ tab, label: `${t("database.result.result")} ${resultNo}` });
    }
  }

  const current =
    typeof active === "number"
      ? (shown.find((entry) => entry.tab.id === active)?.tab ?? null)
      : null;

  const explainAgain = async (tab: ResultTab) => {
    if (tab.busy) return;
    patchResult(tabKey, tab.id, { busy: true });
    try {
      const plan = await dbExplain(sourceId, tab.statement.text);
      patchResult(tabKey, tab.id, { plan, busy: false });
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code !== "cancelled") {
        toast.error(
          code
            ? t(`database.error.${code}`, {
                defaultValue: (error as { message: string }).message,
              })
            : error instanceof Error
              ? error.message
              : String(error)
        );
      }
      patchResult(tabKey, tab.id, { busy: false });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="bg-muted/40 flex shrink-0 items-stretch gap-1 overflow-x-auto border-b px-1 py-1">
        <div
          className={cn(
            "flex shrink-0 items-center rounded-md text-xs",
            current === null ? "bg-background shadow-sm" : "hover:bg-accent/60"
          )}
        >
          <button
            type="button"
            className="px-2 py-1"
            aria-current={current === null ? "true" : undefined}
            onClick={() => setActiveResult(tabKey, "output")}
          >
            {t("database.result.output")}
          </button>
        </div>
        {shown.map(({ tab, label }) => {
          const selected = current?.id === tab.id;
          return (
            <div
              key={tab.id}
              className={cn(
                "flex shrink-0 items-center rounded-md text-xs",
                selected ? "bg-background shadow-sm" : "hover:bg-accent/60"
              )}
            >
              <button
                type="button"
                className="max-w-56 truncate px-2 py-1 text-left"
                title={tab.statement.text}
                aria-current={selected ? "true" : undefined}
                onClick={() => setActiveResult(tabKey, tab.id)}
              >
                {label}
              </button>
              <button
                type="button"
                className="hover:bg-accent mr-1 rounded-sm p-1"
                aria-label={t("database.tab.close")}
                title={t("database.tab.close")}
                onClick={() => removeResult(tabKey, tab.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {current === null ? (
          outputs.length > 0 ? (
            <OutputList lines={outputs} />
          ) : (
            <p className="text-muted-foreground p-3 text-xs">{t("database.result.noResults")}</p>
          )
        ) : current.plan !== null ? (
          <PlanView
            nodes={current.plan}
            busy={current.busy}
            onExplainAgain={() => void explainAgain(current)}
          />
        ) : (
          <ResultView
            tabKey={tabKey}
            tab={current}
            sourceId={sourceId}
            target={target}
            onRerun={() => void rerunResult(tabKey, current.id)}
          />
        )}
      </div>
    </div>
  );
}

const KIND_ICON = {
  info: Info,
  statement: Code2,
  result: Table2,
  error: AlertTriangle,
} as const;

/** What the statements of the last run printed, newest last. */
function OutputList({ lines }: { lines: OutputLine[] }): ReactNode {
  return (
    <ul className="divide-border divide-y overflow-auto text-xs">
      {lines.map((line) => {
        const Icon = KIND_ICON[line.kind];
        const failed = line.kind === "error";
        return (
          <li key={line.id} className="flex items-start gap-2 px-3 py-1">
            <span className="text-muted-foreground w-16 shrink-0 tabular-nums">
              {new Date(line.time).toLocaleTimeString()}
            </span>
            <Icon
              className={cn(
                "mt-0.5 size-3 shrink-0",
                failed ? "text-destructive" : "text-muted-foreground"
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "min-w-0 flex-1 font-mono break-all whitespace-pre-wrap",
                failed && "text-destructive"
              )}
            >
              {line.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
