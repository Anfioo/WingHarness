import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AlignLeft,
  Check,
  Eraser,
  FastForward,
  Loader2,
  Play,
  Plug,
  PlugZap,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  dbCancel,
  dbCompletion,
  dbConnect,
  dbDisconnect,
  dbExecute,
  dbFinishTransaction,
  dbHistory,
  dbRemoveHistory,
  dbSetManualCommit,
  dbSourceList,
  dbSourceSetPassword,
  dbStatements,
  databaseErrorCode,
} from "@/commands";
import type { CompletionModel, DataSourceView, HistoryEntry, StatementOutcome } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ConsoleEditor, type ConsoleEditorHandle } from "./console-editor";
import { ObjectTree } from "./object-tree";
import { ResultView } from "./result-view.tsx";

/** Rows fetched per statement. A larger result is paged by the grid. */
const MAX_ROWS = 500;

/** The result strip selects this pseudo-tab or one statement's result. */
const OUTPUT = "output";
const RESULT = "result:";

type Status = "idle" | "connecting" | "connected";

/** The last statement with a result set, else `null`; it is selected after a run. */
function lastResultKey(outcomes: StatementOutcome[]): string | null {
  for (let index = outcomes.length - 1; index >= 0; index--) {
    const result = outcomes[index]!.result;
    if (result && result.columns.length > 0) return `${RESULT}${index}`;
  }
  return null;
}

/**
 * The SQL console of one data source: connect, run the statement at the caret
 * or the selection, cancel it, and browse the query history.
 *
 * A run is one batch: the editor's statement text is split by the engine, then
 * executed in order. A failing statement stops the batch and is reported in
 * its own outcome, so the ones before it keep their results. Cancellation
 * needs an id for the batch in flight, because the backend registry is keyed
 * by it (`db_cancel`); it is created per run so a cancelled batch and its
 * successor never share one.
 */
export function ConsoleView({ sourceId }: { sourceId: string }) {
  const { t } = useAppTranslation();

  const [source, setSource] = useState<DataSourceView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState(false);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);

  const [manual, setManual] = useState(false);
  const [statement, setStatement] = useState("");
  const [completion, setCompletion] = useState<CompletionModel | null>(null);
  const [outcomes, setOutcomes] = useState<StatementOutcome[] | null>(null);
  const [activeResult, setActiveResult] = useState(OUTPUT);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const requestRef = useRef<string | null>(null);
  const editorRef = useRef<ConsoleEditorHandle | null>(null);

  const resultTabs = useMemo(
    () =>
      (outcomes ?? [])
        .map((outcome, index) => ({ outcome, index }))
        .filter((entry) => !!entry.outcome.result && entry.outcome.result.columns.length > 0),
    [outcomes]
  );
  const activeOutcome = activeResult.startsWith(RESULT)
    ? outcomes?.[Number(activeResult.slice(RESULT.length))]
    : undefined;
  const activeResultValue =
    activeOutcome?.result && activeOutcome.result.columns.length > 0 ? activeOutcome.result : null;

  /**
   * Appends a statement generated from the object tree (its SELECT). The
   * console has one connection, so a table of another PostgreSQL database
   * cannot be queried from here.
   */
  const insertStatement = useCallback(
    (target: string, sql: string) => {
      if (target !== sourceId) {
        toast.info(t("database.tree.otherDatabase"));
        return;
      }
      setStatement((current) =>
        current.trim() ? `${current.replace(/\s+$/, "")}\n\n${sql}` : sql
      );
      editorRef.current?.focus();
    },
    [sourceId, t]
  );

  const describeFailure = useCallback(
    (failure: unknown) => {
      const code = databaseErrorCode(failure);
      if (code) {
        return t(`database.error.${code}`, {
          defaultValue: (failure as { message: string }).message,
        });
      }
      return failure instanceof Error ? failure.message : String(failure);
    },
    [t]
  );

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await dbHistory(sourceId));
    } catch {
      // The history is a convenience; losing it must not fail the console.
      setHistory([]);
    }
  }, [sourceId]);

  const loadCompletion = useCallback(async () => {
    try {
      setCompletion(await dbCompletion(sourceId));
    } catch {
      // Without a model the editor still highlights and formats; it only
      // loses completion and unresolved-name diagnostics.
      setCompletion(null);
    }
  }, [sourceId]);

  const connect = useCallback(
    async (options?: { password?: string; remember?: boolean }) => {
      if (!source) return;
      setStatus("connecting");
      setConnectError(null);
      try {
        if (options?.password) {
          // A typed password is kept for the session, and saved when asked.
          await dbSourceSetPassword(source.id, options.password, options.remember ?? false);
        }
        await dbConnect(source.id);
        setStatus("connected");
        setPasswordPrompt(false);
        setPassword("");
        if (source.options.transaction === "manual") {
          await dbSetManualCommit(source.id, true);
          setManual(true);
        }
        void refreshHistory();
        void loadCompletion();
      } catch (failure) {
        setStatus("idle");
        setConnectError(describeFailure(failure));
        // A rejected password is the one failure the user can fix right here.
        if (databaseErrorCode(failure) === "auth-failed") setPasswordPrompt(true);
      }
    },
    [describeFailure, loadCompletion, refreshHistory, source]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await dbSourceList();
        if (cancelled) return;
        const found = list.find((entry) => entry.id === sourceId) ?? null;
        setSource(found);
        if (!found) setLoadError(t("database.window.missingTitle"));
      } catch (failure) {
        if (!cancelled) setLoadError(describeFailure(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [describeFailure, sourceId, t]);

  // Another data source means another schema model and another result strip.
  useEffect(() => {
    setCompletion(null);
    setOutcomes(null);
    setActiveResult(OUTPUT);
    setQueryError(null);
  }, [sourceId]);

  // Connecting is idempotent on the engine side: an open pool is reused, so a
  // window opened twice, or a StrictMode double effect, costs nothing.
  useEffect(() => {
    if (source) void connect();
  }, [connect, source]);

  const run = async (all: boolean) => {
    if (running || status !== "connected") return;
    const input = all ? statement : (editorRef.current?.currentStatement(-1, -1) ?? "");
    const text = input.trim();
    if (!text) return;

    const request = crypto.randomUUID();
    requestRef.current = request;
    setRunning(true);
    setQueryError(null);
    try {
      const statements = await dbStatements(sourceId, text, 0, text.length);
      if (statements.length === 0) {
        setOutcomes(null);
        setActiveResult(OUTPUT);
        return;
      }
      // The engine stops at the first failure; a statement's error is in its
      // own outcome, so the array is never truncated here.
      const batch = await dbExecute(request, sourceId, statements, 0, MAX_ROWS);
      setOutcomes(batch);
      setActiveResult(lastResultKey(batch) ?? OUTPUT);
      void refreshHistory();
    } catch (failure) {
      setOutcomes(null);
      setActiveResult(OUTPUT);
      setQueryError(
        databaseErrorCode(failure) === "cancelled"
          ? t("database.window.cancelled")
          : describeFailure(failure)
      );
    } finally {
      requestRef.current = null;
      setRunning(false);
    }
  };

  const cancel = async () => {
    if (requestRef.current) await dbCancel(requestRef.current);
  };

  const disconnect = async () => {
    try {
      await dbDisconnect(sourceId);
      setStatus("idle");
      setManual(false);
      // Names from a closed pool must not linger in completion or diagnostics.
      setCompletion(null);
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };

  const toggleManual = async (next: boolean) => {
    setManual(next);
    try {
      await dbSetManualCommit(sourceId, next);
    } catch (failure) {
      setManual(!next);
      toast.error(describeFailure(failure));
    }
  };

  const finish = async (commit: boolean) => {
    try {
      await dbFinishTransaction(sourceId, commit);
      toast.success(
        commit
          ? t("database.window.committed", { defaultValue: "Transaction committed." })
          : t("database.window.rolledBack", { defaultValue: "Transaction rolled back." })
      );
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };

  const forgetHistory = async (texts: string[] | null) => {
    try {
      await dbRemoveHistory(sourceId, texts);
      await refreshHistory();
    } catch (failure) {
      toast.error(describeFailure(failure));
    }
  };

  if (loadError) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
        <AlertTriangle className="size-7" />
        <p className="text-foreground font-medium">{loadError}</p>
        <p className="max-w-md text-xs">
          {t("database.window.missingDescription", {
            defaultValue: "The data source was deleted or belongs to another project.",
          })}
        </p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
        <Loader2 className="size-5 animate-spin" />
        {t("database.loading")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-72 shrink-0 flex-col border-r md:flex">
        <ObjectTree
          source={source}
          enabled={status === "connected"}
          onInsertSelect={insertStatement}
        />

        <section className="flex h-52 shrink-0 flex-col border-t">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-sm font-medium">{t("database.window.history")}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={history.length === 0}
              aria-label={t("database.window.clearHistory")}
              title={t("database.window.clearHistory")}
              onClick={() => void forgetHistory(null)}
            >
              <Eraser />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {history.length === 0 ? (
              <p className="text-muted-foreground p-3 text-xs">
                {t("database.window.historyEmpty")}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {history.map((entry) => (
                  <li key={`${entry.time}-${entry.text}`} className="group flex items-start gap-1">
                    <button
                      type="button"
                      className="hover:bg-accent/60 min-w-0 flex-1 px-3 py-2 text-left"
                      title={entry.text}
                      onClick={() => setStatement(entry.text)}
                    >
                      <span className="line-clamp-2 font-mono text-xs break-all">{entry.text}</span>
                      <span className="text-muted-foreground mt-1 block text-[11px]">
                        {new Date(entry.time).toLocaleString()}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mt-1.5 mr-1 opacity-0 group-hover:opacity-100"
                      aria-label={t("database.window.removeEntry")}
                      onClick={() => void forgetHistory([entry.text])}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Badge variant={status === "connected" ? "default" : "secondary"}>
            {status === "connected"
              ? t("database.list.connected")
              : status === "connecting"
                ? t("database.window.connecting", { defaultValue: "Connecting…" })
                : t("database.list.disconnected")}
          </Badge>
          <span className="truncate text-sm font-medium">{source.name}</span>
          <Badge variant="outline">{t(`database.driver.${source.driver}`)}</Badge>

          <div className="ml-auto flex items-center gap-2">
            {status === "connected" ? (
              <>
                <div className="flex items-center gap-2">
                  <Switch
                    id="database-console-manual"
                    checked={manual}
                    onCheckedChange={(checked) => void toggleManual(checked)}
                  />
                  <Label htmlFor="database-console-manual" className="text-xs font-normal">
                    {t("database.form.manualCommit")}
                  </Label>
                </div>
                {manual && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => void finish(true)}>
                      <Check />
                      {t("database.window.commit", { defaultValue: "Commit" })}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void finish(false)}>
                      <RotateCcw />
                      {t("database.window.rollback", { defaultValue: "Roll back" })}
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
                  <Plug />
                  {t("database.window.disconnect", { defaultValue: "Disconnect" })}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={status === "connecting"}
                onClick={() => void connect()}
              >
                {status === "connecting" ? <Loader2 className="animate-spin" /> : <PlugZap />}
                {t("database.window.connect", { defaultValue: "Connect" })}
              </Button>
            )}
          </div>
        </div>

        {(connectError || passwordPrompt) && status !== "connected" && (
          <div className="border-b px-3 py-2">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void connect({ password, remember });
              }}
            >
              {connectError && (
                <p className="text-destructive flex w-full items-center gap-1.5 text-xs">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span className="break-words">{connectError}</span>
                </p>
              )}
              <div className="flex min-w-48 flex-1 flex-col gap-1">
                <Label htmlFor="database-console-password" className="text-xs">
                  {t("database.form.password")}
                </Label>
                <Input
                  id="database-console-password"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Switch
                  id="database-console-remember"
                  checked={remember}
                  onCheckedChange={setRemember}
                />
                <Label htmlFor="database-console-remember" className="text-xs font-normal">
                  {t("database.form.savePassword")}
                </Label>
              </div>
              <Button type="submit" size="sm" disabled={status === "connecting"}>
                {status === "connecting" ? <Loader2 className="animate-spin" /> : <PlugZap />}
                {t("database.window.connect", { defaultValue: "Connect" })}
              </Button>
            </form>
          </div>
        )}

        <div className="border-b p-3">
          <div className="h-48 overflow-hidden rounded-md border">
            <ConsoleEditor
              ref={editorRef}
              value={statement}
              onChange={setStatement}
              model={completion}
              driver={source.driver}
              onRun={() => void run(false)}
              onRunAll={() => void run(true)}
              onFormat={() => editorRef.current?.format()}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {running ? (
              <Button variant="destructive" size="sm" onClick={() => void cancel()}>
                <Square />
                {t("database.window.cancel", { defaultValue: "Cancel" })}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={status !== "connected" || !statement.trim()}
                  title={`${t("database.console.runAtCursor")} (Ctrl+Enter)`}
                  onClick={() => void run(false)}
                >
                  <Play />
                  {t("database.console.run")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={status !== "connected" || !statement.trim()}
                  title={`${t("database.console.runAll")} (Ctrl+Shift+Enter)`}
                  onClick={() => void run(true)}
                >
                  <FastForward />
                  {t("database.console.runAll")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!statement.trim()}
                  title={`${t("database.console.format")} (Ctrl+Alt+L)`}
                  onClick={() => editorRef.current?.format()}
                >
                  <AlignLeft />
                  {t("database.console.format")}
                </Button>
              </>
            )}
            {running && (
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Loader2 className="size-3.5 animate-spin" />
                {t("database.window.running", { defaultValue: "Running…" })}
              </span>
            )}
            <span className="text-muted-foreground ml-auto font-mono text-[11px]">
              {t("database.window.runHint", { defaultValue: "Ctrl+Enter runs the statement" })}
            </span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {queryError && (
            <div className="border-destructive/40 bg-destructive/5 text-destructive m-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{queryError}</span>
            </div>
          )}

          <div className="bg-muted/40 flex shrink-0 items-stretch gap-1 overflow-x-auto border-y px-1 py-1">
            <button
              type="button"
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                activeResultValue ? "hover:bg-accent/60" : "bg-background shadow-sm"
              )}
              onClick={() => setActiveResult(OUTPUT)}
            >
              {t("database.console.output")}
            </button>
            {resultTabs.map(({ index }, position) => {
              const key = `${RESULT}${index}`;
              return (
                <button
                  key={key}
                  type="button"
                  className={cn(
                    "rounded-md px-2 py-1 text-xs",
                    activeResult === key ? "bg-background shadow-sm" : "hover:bg-accent/60"
                  )}
                  onClick={() => setActiveResult(key)}
                >
                  {t("database.console.result")} {position + 1}
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {activeResultValue ? (
              <ResultView result={activeResultValue} />
            ) : (
              <div className="h-full overflow-auto">
                {outcomes && outcomes.length > 0 ? (
                  <OutputList outcomes={outcomes} />
                ) : (
                  <p className="text-muted-foreground p-3 text-xs">
                    {t("database.window.emptyResult", {
                      defaultValue: "The result of the statement appears here.",
                    })}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Every statement of the last batch: its number, text, outcome and timing. */
function OutputList({ outcomes }: { outcomes: StatementOutcome[] }) {
  const { t } = useAppTranslation();

  return (
    <div>
      <div className="text-muted-foreground border-b px-3 py-1 text-[11px]">
        {t("database.console.statementCount", { count: outcomes.length })}
      </div>
      <ul className="divide-border divide-y text-xs">
        {outcomes.map((outcome, index) => {
          const preview = outcome.statement.text.replace(/\s+/g, " ").trim();
          const clipped = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
          const code = outcome.error ? databaseErrorCode(outcome.error) : null;
          return (
            <li key={index} className="flex items-start gap-2 px-3 py-1.5">
              <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 font-mono break-all">{clipped}</span>
              {outcome.error ? (
                <span className="text-destructive flex max-w-[50%] min-w-0 items-start gap-1">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <span className="break-words">
                    {code
                      ? t(`database.error.${code}`, { defaultValue: outcome.error.message })
                      : outcome.error.message}
                  </span>
                </span>
              ) : outcome.result ? (
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {outcome.result.columns.length > 0
                    ? t("database.window.rowCount", { count: outcome.result.rows.length })
                    : outcome.result.affected !== null
                      ? t("database.window.affected", { count: outcome.result.affected })
                      : t("database.window.done")}
                  {" · "}
                  {Math.round(outcome.result.elapsedMs)} ms
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
