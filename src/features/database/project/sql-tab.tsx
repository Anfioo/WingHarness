// A SQL tab of the project page: a query file from `<project root>/.wh/db/query`
// or any `.sql` file of the project, edited by the same CodeMirror editor the
// database windows use.
//
// The tab's text lives in the project store, keyed by tab id; a query file is
// written back through the project workspace, a `.sql` file through the project
// file commands with the change tag it was read with, so a file changed
// underneath is refused rather than overwritten. Results go to the dock below,
// not here — this view only owns the editor and its toolbar.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  AlignLeft,
  Check,
  FastForward,
  History,
  ListTree,
  Loader2,
  Play,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import {
  databaseErrorCode,
  dbCompletion,
  dbStatements,
  type CompletionModel,
  type DbDriver,
  type SqlStatement,
} from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { ConsoleEditor, type ConsoleEditorHandle } from "@/pages/database/console-editor";
import { HistoryDialog } from "@/pages/database/history-dialog";
import { ParamsDialog } from "@/pages/database/params-dialog";
import {
  bindQueryRunner,
  cancelQuery,
  isRunning,
  runPlan,
  runQuery,
  runStatements,
  subscribeRunning,
} from "@/pages/database/query-runner";
import { bindParams, findParams, type SqlParam } from "@/pages/database/sql/params";
import type { QueryDoc } from "@/pages/database/model";
import {
  connectionOf,
  isSqlTab,
  useProjectDb,
  type ProjectDbTab,
} from "@/features/database/project/view-store";

const ROW_LIMITS = [100, 500, 1000, 5000, 50000];

/** One statement and the parameters it carries, awaiting the dialog. */
type PendingParams = {
  names: string[];
  statements: Array<{ statement: SqlStatement; params: SqlParam[] }>;
};

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectSqlTab({ tab }: { tab: ProjectDbTab }): ReactNode {
  const { t } = useAppTranslation();
  const sqlTab = isSqlTab(tab) ? tab : null;
  const tabId = tab.id;

  const sources = useProjectDb((state) => state.sources);
  const sourcesStatus = useProjectDb((state) => state.sourcesStatus);
  const loadSources = useProjectDb((state) => state.loadSources);
  const connections = useProjectDb((state) => state.connections);
  const manualCommits = useProjectDb((state) => state.manualCommits);
  const settings = useProjectDb((state) => state.settings);
  const doc = useProjectDb((state) => state.docs[tabId]) as QueryDoc | undefined;
  const conflict = useProjectDb((state) => state.conflicts[tabId] ?? false);
  const saving = useProjectDb((state) => state.saving[tabId] ?? false);
  const appendOutput = useProjectDb((state) => state.appendOutput);
  const setResults = useProjectDb((state) => state.setResults);
  const setActiveResult = useProjectDb((state) => state.setActiveResult);
  const setText = useProjectDb((state) => state.setText);
  const flush = useProjectDb((state) => state.flush);
  const reloadFile = useProjectDb((state) => state.reloadFile);
  const overwriteFile = useProjectDb((state) => state.overwriteFile);
  const setTabSource = useProjectDb((state) => state.setTabSource);
  const connect = useProjectDb((state) => state.connect);
  const setManualCommit = useProjectDb((state) => state.setManualCommit);
  const finishTransaction = useProjectDb((state) => state.finishTransaction);
  const setConsoleRows = useProjectDb((state) => state.setConsoleRows);
  const openDock = useProjectDb((state) => state.openDock);

  const sourceId = sqlTab?.sourceId ?? "";
  const connection = connectionOf(connections, sourceId);
  const connected = connection.status === "connected";
  const connecting = connection.status === "connecting";
  const manualCommit = manualCommits[sourceId] ?? false;

  const [completion, setCompletion] = useState<CompletionModel | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState<PendingParams | null>(null);

  const editorRef = useRef<ConsoleEditorHandle | null>(null);
  /** The editor's live selection; empty means "the statement at the caret". */
  const selection = useRef({ from: 0, to: 0 });
  const docRef = useRef<QueryDoc | undefined>(doc);
  const rowsRef = useRef(settings.consoleRows);

  const running = useSyncExternalStore(subscribeRunning, () => isRunning(tabId));

  const driver: DbDriver = sources.find((source) => source.id === sourceId)?.driver ?? "sqlite";
  const text = doc?.text ?? "";

  useEffect(() => {
    docRef.current = doc;
    rowsRef.current = settings.consoleRows;
  });

  // The source picker lists what the project store holds; opening a query tab
  // directly must not depend on the side panel having mounted first.
  useEffect(() => {
    if (sourcesStatus === "idle") void loadSources();
  }, [loadSources, sourcesStatus]);

  // The runner is a singleton; this tab hands it the project store's accessors
  // while it is mounted.
  useEffect(() => {
    bindQueryRunner({
      sourceId,
      consoleRows: () => rowsRef.current,
      results: (key) => useProjectDb.getState().results[key] ?? [],
      append: (key, line) => appendOutput(key, line),
      setResults: (key, list) => setResults(key, list),
      setActiveResult: (key, id) => setActiveResult(key, id),
    });
    return () => {
      bindQueryRunner(null);
    };
  }, [appendOutput, setActiveResult, setResults, sourceId]);

  // A different tab reuses this component; offsets and dialogs do not carry over.
  useEffect(() => {
    selection.current = { from: 0, to: 0 };
    setPending(null);
    setHistoryOpen(false);
  }, [tabId]);

  // Completion follows the connection: a pool that is not open has no catalog.
  useEffect(() => {
    if (!connected || !sourceId) {
      setCompletion(null);
      return;
    }
    let live = true;
    dbCompletion(sourceId).then(
      (model) => {
        if (live) setCompletion(model);
      },
      () => {
        if (live) setCompletion(null);
      }
    );
    return () => {
      live = false;
    };
  }, [connected, sourceId]);

  const describeFailure = useCallback(
    (error: unknown) => {
      const code = databaseErrorCode(error);
      if (code) {
        return t(`database.error.${code}`, {
          defaultValue: (error as { message: string }).message,
        });
      }
      return failureText(error);
    },
    [t]
  );

  /** Appends SQL to this tab, separated from what is already there by a blank line. */
  const appendSql = useCallback(
    (sql: string) => {
      const current = docRef.current?.text ?? "";
      const next = current.trim() ? `${current.replace(/\s+$/, "")}\n\n${sql}` : sql;
      setText(tabId, next);
      editorRef.current?.focus();
    },
    [setText, tabId]
  );

  const run = useCallback(
    async (all: boolean) => {
      const current = docRef.current?.text ?? "";
      if (!current.trim() || running || !connected) return;
      openDock();

      // Without a parameter anywhere the engine splits the range on its own.
      if (findParams(current, driver).length === 0) {
        const from = all ? 0 : selection.current.from;
        const to = all ? current.length : selection.current.to;
        await runQuery(sourceId, tabId, current, from, to);
        return;
      }

      const from = all ? 0 : selection.current.from;
      const to = all ? current.length : selection.current.to;
      let statements: SqlStatement[];
      try {
        statements = await dbStatements(sourceId, current, from, to);
      } catch (error) {
        toast.error(describeFailure(error));
        return;
      }
      if (statements.length === 0) {
        toast.info(t("database.console.noStatement"));
        return;
      }

      // Parameters are bound per statement: replacing them in the whole text
      // first would move the offsets the split returned.
      let positional = 0;
      const planned = statements.map((statement) => {
        const params = findParams(statement.text, driver, positional);
        positional += params.filter((param) => param.positional).length;
        return { statement, params };
      });
      const names = [
        ...new Set(planned.flatMap((entry) => entry.params.map((param) => param.name))),
      ];
      if (names.length === 0) {
        await runStatements(sourceId, tabId, statements);
        return;
      }
      setPending({ names, statements: planned });
    },
    [connected, describeFailure, driver, openDock, running, sourceId, t, tabId]
  );

  const explain = useCallback(async () => {
    const current = docRef.current?.text ?? "";
    if (!current.trim() || running || !connected) return;
    openDock();

    let statements: SqlStatement[];
    try {
      statements = await dbStatements(
        sourceId,
        current,
        selection.current.from,
        selection.current.to
      );
    } catch (error) {
      toast.error(describeFailure(error));
      return;
    }
    const statement = statements[0];
    if (!statement) {
      toast.info(t("database.console.noStatement"));
      return;
    }
    await runPlan(sourceId, tabId, statement.text);
  }, [connected, describeFailure, openDock, running, sourceId, t, tabId]);

  const submitParams = useCallback(
    (values: Record<string, string>) => {
      const job = pending;
      setPending(null);
      if (!job) return;
      const bound = job.statements.map(({ statement, params }) => {
        const boundText = bindParams(statement.text, params, values);
        return { from: 0, to: boundText.length, text: boundText };
      });
      void runStatements(sourceId, tabId, bound);
    },
    [pending, sourceId, tabId]
  );

  /** A failed write is retried by writing again; the error banner offers both ways. */
  const retrySave = () => {
    if (!doc) return;
    void flush(tabId);
  };

  const toggleManual = (manual: boolean) => {
    setManualCommit(sourceId, manual).catch((error: unknown) =>
      toast.error(describeFailure(error))
    );
  };

  const finish = (commit: boolean) => {
    finishTransaction(sourceId, commit)
      .then(() =>
        toast.success(commit ? t("database.window.committed") : t("database.window.rolledBack"))
      )
      .catch((error: unknown) => toast.error(describeFailure(error)));
  };

  const changeRows = (value: string) => {
    setConsoleRows(Number(value)).catch((error: unknown) => toast.error(describeFailure(error)));
  };

  const changeSource = (next: string) => {
    setTabSource(tabId, next);
    setCompletion(null);
    connect(next).catch((error: unknown) => toast.error(describeFailure(error)));
  };

  const paramCount = useMemo(() => (doc ? findParams(doc.text, driver).length : 0), [doc, driver]);

  const canRun = connected && text.trim().length > 0;
  const fileName = doc?.file ?? tabId;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Select value={sourceId || undefined} onValueChange={changeSource}>
          <SelectTrigger
            size="sm"
            className="w-40"
            aria-label={t("projectDb.sql.sourceLabel")}
            title={t("projectDb.sql.sourceLabel")}
          >
            <SelectValue placeholder={t("projectDb.sql.noSource")} />
          </SelectTrigger>
          <SelectContent>
            {sources.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                {source.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {running ? (
          <Button variant="destructive" size="sm" onClick={() => void cancelQuery(sourceId, tabId)}>
            <Square />
            {t("database.console.stop")}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={!canRun}
              title={`${t("database.console.runAtCursor")} (Ctrl+Enter)`}
              onClick={() => void run(false)}
            >
              <Play />
              {t("database.console.run")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canRun}
              title={`${t("database.console.runAll")} (Ctrl+Shift+Enter)`}
              onClick={() => void run(true)}
            >
              <FastForward />
              {t("database.console.runAll")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canRun}
              title={`${t("database.console.explain")} (Alt+Enter)`}
              onClick={() => void explain()}
            >
              <ListTree />
              {t("database.console.explain")}
            </Button>
          </>
        )}

        <Button
          variant="outline"
          size="sm"
          disabled={!text.trim()}
          title={`${t("database.console.format")} (Ctrl+Alt+L)`}
          onClick={() => editorRef.current?.format()}
        >
          <AlignLeft />
          {t("database.console.format")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!sourceId}
          onClick={() => setHistoryOpen(true)}
        >
          <History />
          {t("database.console.history")}
        </Button>

        <Select value={String(settings.consoleRows)} onValueChange={changeRows}>
          <SelectTrigger
            size="sm"
            className="w-32"
            aria-label={t("database.console.rowLimit")}
            title={t("database.console.rowLimit")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROW_LIMITS.map((rows) => (
              <SelectItem key={rows} value={String(rows)}>
                {t("database.console.rowLimitOption", { count: rows })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {driver !== "clickhouse" && (
          <>
            <Select
              value={manualCommit ? "manual" : "auto"}
              onValueChange={(value) => toggleManual(value === "manual")}
              disabled={!connected}
            >
              <SelectTrigger
                size="sm"
                className="w-36"
                aria-label={t("database.console.transaction")}
                title={t("database.console.transaction")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("database.console.auto")}</SelectItem>
                <SelectItem value="manual">{t("database.console.manual")}</SelectItem>
              </SelectContent>
            </Select>
            {manualCommit && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!connected}
                  onClick={() => finish(true)}
                >
                  <Check />
                  {t("database.console.commit")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!connected}
                  onClick={() => finish(false)}
                >
                  <RotateCcw />
                  {t("database.console.rollback")}
                </Button>
              </>
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {saving && (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="size-3.5 animate-spin" />
              {t("projectDb.sql.saving")}
            </span>
          )}
          {running && (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="size-3.5 animate-spin" />
              {t("database.window.running")}
            </span>
          )}
          {paramCount > 0 && (
            <span
              className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[11px]"
              title={t("database.console.params")}
            >
              {t("database.console.params")} · {paramCount}
            </span>
          )}
          {!connected && sourceId && (
            <Button
              variant="outline"
              size="sm"
              disabled={connecting}
              onClick={() => connect(sourceId).catch(() => undefined)}
            >
              {connecting ? <Loader2 className="animate-spin" /> : <PlugZap />}
              {t("database.console.connect")}
            </Button>
          )}
        </div>
      </div>

      {conflict && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{t("projectDb.sql.conflict")}</span>
          <Button variant="outline" size="xs" onClick={() => void reloadFile(tabId)}>
            <RefreshCw />
            {t("projectDb.sql.reload")}
          </Button>
          <Button variant="outline" size="xs" onClick={() => void overwriteFile(tabId)}>
            {t("projectDb.sql.overwrite")}
          </Button>
        </div>
      )}

      {doc?.error && !conflict && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 border-b px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{doc.error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("database.action.retry")}
            title={t("database.action.retry")}
            onClick={retrySave}
          >
            <RefreshCw />
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden p-3">
        <div className="h-full overflow-hidden rounded-md border">
          <ConsoleEditor
            ref={editorRef}
            value={text}
            onChange={(next) => setText(tabId, next)}
            model={completion}
            driver={driver}
            onRun={() => void run(false)}
            onRunAll={() => void run(true)}
            onExplain={() => void explain()}
            onFormat={() => editorRef.current?.format()}
            onSelectionChange={(from, to) => {
              selection.current = { from, to };
            }}
            readOnly={!connected}
          />
        </div>
      </div>

      <div className="text-muted-foreground flex shrink-0 items-center gap-2 border-t px-3 py-1 text-[11px]">
        <span className="min-w-0 flex-1 truncate" title={fileName}>
          {fileName}
        </span>
        {!sourceId ? (
          <span>{t("projectDb.sql.noSourceHint")}</span>
        ) : !connected ? (
          <span>{t("database.console.notConnected")}</span>
        ) : (
          <span>{t("projectDb.sql.saved")}</span>
        )}
      </div>

      <HistoryDialog
        open={historyOpen}
        sourceId={sourceId}
        onOpenChange={setHistoryOpen}
        onPaste={appendSql}
      />

      <ParamsDialog
        open={pending !== null}
        names={pending?.names ?? []}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        onSubmit={submitParams}
      />
    </div>
  );
}
