// The bottom dock of the project page: the results, output and plan tabs of
// the SQL tab that is in front, or the last SQL tab when a table tab is.
//
// Running a statement opens it; the × closes it until the next run. The rerun /
// paging / COUNT actions are bound here rather than in the SQL tab, because
// they are a singleton and the dock outlives the editor's mount when a table
// tab takes the front.

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { bindResultActions, rerunResult } from "@/pages/database/result-actions";
import { ResultTabsView } from "@/pages/database/result-tabs";
import type { OutputLine, ResultTab } from "@/pages/database/model";
import {
  dockTab,
  isSqlTab,
  projectTabTitle,
  useProjectDb,
} from "@/features/database/project/view-store";

const NO_RESULTS: ResultTab[] = [];
const NO_OUTPUT: OutputLine[] = [];

export function ProjectResultsDock(): ReactNode {
  const { t } = useAppTranslation();

  const tab = useProjectDb(dockTab);
  const sources = useProjectDb((state) => state.sources);
  const results = useProjectDb((state) => (tab ? state.results[tab.id] : undefined)) ?? NO_RESULTS;
  const outputs = useProjectDb((state) => (tab ? state.outputs[tab.id] : undefined)) ?? NO_OUTPUT;
  const active = useProjectDb((state) => (tab ? state.activeResult[tab.id] : undefined));
  const setActiveResult = useProjectDb((state) => state.setActiveResult);
  const removeResult = useProjectDb((state) => state.removeResult);
  const patchResult = useProjectDb((state) => state.patchResult);
  const closeDock = useProjectDb((state) => state.closeDock);
  const select = useProjectDb((state) => state.select);

  const sourceId = tab?.sourceId ?? "";
  const sourceName = sources.find((source) => source.id === sourceId)?.name ?? "";

  // The result actions read the list through this ref, the same way the
  // database window's own result tabs do.
  const resultsRef = useRef(results);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    if (!tab || !isSqlTab(tab)) {
      bindResultActions(null);
      return;
    }
    const tabId = tab.id;
    bindResultActions({
      sourceId,
      result: (key, id) =>
        key === tabId ? resultsRef.current.find((result) => result.id === id) : undefined,
      patch: (key, id, patch) => {
        if (key === tabId) patchResult(key, id, patch);
      },
    });
    return () => bindResultActions(null);
  }, [patchResult, sourceId, tab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="bg-muted/40 flex shrink-0 items-center gap-2 border-b px-2 py-1">
        <Database className="text-muted-foreground size-3.5 shrink-0" />
        {tab ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
            title={projectTabTitle(tab)}
            onClick={() => select(tab.id)}
          >
            {projectTabTitle(tab)}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs">{t("projectDb.results.empty")}</span>
        )}
        {sourceName && (
          <span className="text-muted-foreground shrink-0 truncate text-[11px]">{sourceName}</span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("projectDb.results.close")}
          title={t("projectDb.results.close")}
          onClick={closeDock}
        >
          <ChevronDown />
        </Button>
      </div>

      {tab && isSqlTab(tab) ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ResultTabsView
            tabKey={tab.id}
            sourceId={sourceId}
            target={sourceId}
            results={results}
            outputs={outputs}
            active={active}
            onSelect={(id) => setActiveResult(tab.id, id)}
            onClose={(id) => removeResult(tab.id, id)}
            onPatch={(id, patch) => patchResult(tab.id, id, patch)}
            onRerun={(result) => void rerunResult(tab.id, result.id)}
          />
        </div>
      ) : (
        <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-xs">
          <p>{t("projectDb.results.empty")}</p>
        </div>
      )}
    </div>
  );
}
