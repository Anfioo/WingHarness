// One query tab of a data source window: the SQL editor above, the result
// tabs below.
//
// The editor text, the results and the output all live in the window store;
// this file only lays them out and forwards the user's actions to the runner.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
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
  dbQueryRead,
  dbSourceList,
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
import { useDatabaseStore, type QueryDoc, type ResultTab } from "./store";
import { ConsoleEditor, type ConsoleEditorHandle } from "./console-editor";
import { HistoryDialog } from "./history-dialog";
import { ParamsDialog } from "./params-dialog";
import {
  bindQueryRunner,
  cancelQuery,
  isRunning,
  runPlan,
  runQuery,
  runStatements,
  subscribeRunning,
} from "./query-runner";
import { ResultTabs } from "./result-tabs";
import { bindParams, findParams, type SqlParam } from "./sql/params";

export type QueryTabProps = {
  sourceId: string;
  tabKey: string;
  file: string;
};

/** What the object tree and the history dialog may do to the tab's text. */
export type QueryTabHandle = {
  /** Appends SQL after the current text, as "insert a SELECT" does. */
  insertSql(sql: string): void;
  focus(): void;
};

const ROW_LIMITS = [100, 500, 1000, 5000, 50000];

/** One statement and the parameters it carries, awaiting the dialog. */
type PendingParams = {
  names: string[];
  statements: Array<{ statement: SqlStatement; params: SqlParam[] }>;
};

export function QueryTab(props: QueryTabProps & { ref?: Ref<QueryTabHandle> }): ReactNode {
  const { sourceId, tabKey, file, ref } = props;
  const { t } = useAppTranslation();

  const doc = useDatabaseStore((state) => state.queries[file]);
  const settings = useDatabaseStore((state) => state.settings);
  const connection = useDatabaseStore((state) => state.connection);
  const manualCommit = useDatabaseStore((state) => state.manualCommit);
  const connect = useDatabaseStore((state) => state.connect);
  const setQueryText = useDatabaseStore((state) => state.setQueryText);
  const flushQuery = useDatabaseStore((state) => state.flushQuery);
  const setManualCommit = useDatabaseStore((state) => state.setManualCommit);
  const finishTransaction = useDatabaseStore((state) => state.finishTransaction);
  const setConsoleRows = useDatabaseStore((state) => state.setConsoleRows);
  const results = useDatabaseStore((state) => state.results[tabKey]);
  const appendOutput = useDatabaseStore((state) => state.appendOutput);
  const setResults = useDatabaseStore((state) => state.setResults);
  const setActiveResult = useDatabaseStore((state) => state.setActiveResult);

  const [driver, setDriver] = useState<DbDriver | null>(null);
  const [completion, setCompletion] = useState<CompletionModel | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState<PendingParams | null>(null);

  const editorRef = useRef<ConsoleEditorHandle | null>(null);
  /** The editor's live selection; empty means "the statement at the caret". */
  const selection = useRef({ from: 0, to: 0 });
  const docRef = useRef<QueryDoc | undefined>(doc);
  const rowsRef = useRef(settings.consoleRows);
  const resultsRef = useRef<ResultTab[]>(results ?? []);

  const running = useSyncExternalStore(subscribeRunning, () => isRunning(tabKey));
  const connected = connection.status === "connected";
  const connecting = connection.status === "connecting";
  const resolvedDriver = driver ?? "sqlite";
  const text = doc?.text ?? "";

  useEffect(() => {
    docRef.current = doc;
    rowsRef.current = settings.consoleRows;
    resultsRef.current = results ?? [];
  });

  // The store lives in a React context, so the runner reads it through this
  // binding for as long as the tab is mounted.
  useEffect(() => {
    bindQueryRunner({
      sourceId,
      consoleRows: () => rowsRef.current,
      results: (key) => (key === tabKey ? resultsRef.current : []),
      append: (key, line) => {
        if (key === tabKey) appendOutput(key, line);
      },
      setResults: (key, list) => {
        if (key === tabKey) setResults(key, list);
      },
      setActiveResult: (key, id) => {
        if (key === tabKey) setActiveResult(key, id);
      },
    });
    return () => {
      bindQueryRunner(null);
    };
  }, [appendOutput, setActiveResult, setResults, sourceId, tabKey]);

  // A different tab reuses this component; offsets and dialogs do not carry over.
  useEffect(() => {
    selection.current = { from: 0, to: 0 };
    setPending(null);
    setHistoryOpen(false);
  }, [tabKey]);

  // The driver decides how statements are split, how parameters are found and
  // whether the engine has user-controlled transactions.
  useEffect(() => {
    let live = true;
    dbSourceList().then(
      (list) => {
        if (live) setDriver(list.find((entry) => entry.id === sourceId)?.driver ?? null);
      },
      () => {
        if (live) setDriver(null);
      }
    );
    return () => {
      live = false;
    };
  }, [sourceId]);

  // Completion and unresolved-name diagnostics follow the connection.
  useEffect(() => {
    if (!connected) {
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
      return error instanceof Error ? error.message : String(error);
    },
    [t]
  );

  /** Appends SQL to the file, separated from what is already there by a blank line. */
  const appendSql = useCallback(
    (sql: string) => {
      const current = docRef.current?.text ?? "";
      const next = current.trim() ? `${current.replace(/\s+$/, "")}\n\n${sql}` : sql;
      setQueryText(file, next);
      editorRef.current?.focus();
    },
    [file, setQueryText]
  );

  useImperativeHandle(
    ref,
    () => ({
      insertSql: appendSql,
      focus() {
        editorRef.current?.focus();
      },
    }),
    [appendSql]
  );

  const run = useCallback(
    async (all: boolean) => {
      const current = docRef.current?.text ?? "";
      if (!current.trim() || running) return;

      // Without a parameter anywhere the engine splits the range on its own.
      if (findParams(current, resolvedDriver).length === 0) {
        const from = all ? 0 : selection.current.from;
        const to = all ? current.length : selection.current.to;
        await runQuery(sourceId, tabKey, current, from, to);
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
        const params = findParams(statement.text, resolvedDriver, positional);
        positional += params.filter((param) => param.positional).length;
        return { statement, params };
      });
      const names = [
        ...new Set(planned.flatMap((entry) => entry.params.map((param) => param.name))),
      ];
      if (names.length === 0) {
        await runStatements(sourceId, tabKey, statements);
        return;
      }
      setPending({ names, statements: planned });
    },
    [describeFailure, resolvedDriver, running, sourceId, t, tabKey]
  );

  const explain = useCallback(async () => {
    const current = docRef.current?.text ?? "";
    if (!current.trim() || running) return;

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
    await runPlan(sourceId, tabKey, statement.text);
  }, [describeFailure, running, sourceId, t, tabKey]);

  const submitParams = useCallback(
    (values: Record<string, string>) => {
      const job = pending;
      setPending(null);
      if (!job) return;
      const bound = job.statements.map(({ statement, params }) => {
        const boundText = bindParams(statement.text, params, values);
        return { from: 0, to: boundText.length, text: boundText };
      });
      void runStatements(sourceId, tabKey, bound);
    },
    [pending, sourceId, tabKey]
  );

  /** A failed read is retried by reading again; a failed save by writing again. */
  const retry = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    if (current.text !== current.savedText) {
      void flushQuery(file);
      return;
    }
    dbQueryRead(file).then(
      (read) => setQueryText(file, read),
      (error: unknown) => toast.error(describeFailure(error))
    );
  }, [describeFailure, file, flushQuery, setQueryText]);

  const toggleManual = (manual: boolean) => {
    setManualCommit(manual).catch((error: unknown) => toast.error(describeFailure(error)));
  };

  const finish = (commit: boolean) => {
    finishTransaction(commit)
      .then(() =>
        toast.success(commit ? t("database.window.committed") : t("database.window.rolledBack"))
      )
      .catch((error: unknown) => toast.error(describeFailure(error)));
  };

  const changeRows = (value: string) => {
    setConsoleRows(Number(value)).catch((error: unknown) => toast.error(describeFailure(error)));
  };

  const paramCount = useMemo(
    () => (doc ? findParams(doc.text, resolvedDriver).length : 0),
    [doc, resolvedDriver]
  );

  const canRun = connected && text.trim().length > 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {running ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void cancelQuery(sourceId, tabKey)}
          >
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
        <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
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

        {driver !== null && driver !== "clickhouse" && (
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
          {!connected && (
            <Button
              variant="outline"
              size="sm"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? <Loader2 className="animate-spin" /> : <PlugZap />}
              {t("database.console.connect")}
            </Button>
          )}
        </div>
      </div>

      <div className="shrink-0 border-b p-3">
        {doc?.error && (
          <div className="border-destructive/40 bg-destructive/5 text-destructive mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{doc.error}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("database.action.retry")}
              title={t("database.action.retry")}
              onClick={retry}
            >
              <RefreshCw />
            </Button>
          </div>
        )}

        <div className="h-56 overflow-hidden rounded-md border">
          <ConsoleEditor
            ref={editorRef}
            value={text}
            onChange={(next) => setQueryText(file, next)}
            model={completion}
            driver={resolvedDriver}
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

        {!connected && (
          <p className="text-muted-foreground mt-2 text-xs">{t("database.console.notConnected")}</p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <ResultTabs key={tabKey} tabKey={tabKey} sourceId={sourceId} target={sourceId} />
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
