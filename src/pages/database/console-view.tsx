import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Eraser,
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
import type { DataSourceView, HistoryEntry, QueryResult } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { ObjectTree } from "./object-tree";

/** Rows fetched per statement. A larger result is paged; P2 adds "load more". */
const MAX_ROWS = 500;

type Status = "idle" | "connecting" | "connected";

/**
 * The SQL console of one data source: connect, run a statement, cancel it, and
 * browse the query history.
 *
 * Cancellation needs an id for the statement in flight, because the backend
 * registry is keyed by it (`db_cancel`). The id is created per run rather than
 * per console so a cancelled statement and its successor never share one.
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
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const requestRef = useRef<string | null>(null);

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
      } catch (failure) {
        setStatus("idle");
        setConnectError(describeFailure(failure));
        // A rejected password is the one failure the user can fix right here.
        if (databaseErrorCode(failure) === "auth-failed") setPasswordPrompt(true);
      }
    },
    [describeFailure, refreshHistory, source]
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

  // Connecting is idempotent on the engine side: an open pool is reused, so a
  // window opened twice, or a StrictMode double effect, costs nothing.
  useEffect(() => {
    if (source) void connect();
  }, [connect, source]);

  const run = async () => {
    const text = statement.trim();
    if (!text || running || status !== "connected") return;

    const request = crypto.randomUUID();
    requestRef.current = request;
    setRunning(true);
    setQueryError(null);
    try {
      // The console still runs one statement at a time until the multi-result
      // view lands; the split itself already comes from the backend.
      const [first] = await dbStatements(sourceId, text, 0, text.length);
      if (first) {
        const [outcome] = await dbExecute(request, sourceId, [first], 0, MAX_ROWS);
        if (outcome.error) throw outcome.error;
        setResult(outcome.result);
      } else {
        setResult(null);
      }
      void refreshHistory();
    } catch (failure) {
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
          <Textarea
            className="min-h-28 font-mono text-xs"
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            placeholder={t("database.window.statementPlaceholder", {
              defaultValue: "SELECT * FROM …",
            })}
            spellCheck={false}
            onKeyDown={(event) => {
              // Ctrl/Cmd+Enter runs, the shortcut every SQL console uses.
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void run();
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            {running ? (
              <Button variant="destructive" size="sm" onClick={() => void cancel()}>
                <Square />
                {t("database.window.cancel", { defaultValue: "Cancel" })}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={status !== "connected" || !statement.trim()}
                onClick={() => void run()}
              >
                <Play />
                {t("database.window.run", { defaultValue: "Run" })}
              </Button>
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

        <div className="min-h-0 flex-1 overflow-auto">
          {queryError && (
            <div className="border-destructive/40 bg-destructive/5 text-destructive m-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{queryError}</span>
            </div>
          )}
          {result ? (
            <ResultView result={result} />
          ) : (
            !queryError && (
              <p className="text-muted-foreground p-3 text-xs">
                {t("database.window.emptyResult", {
                  defaultValue: "The result of the statement appears here.",
                })}
              </p>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** The grid of one result set, or a one-line summary for a statement without rows. */
function ResultView({ result }: { result: QueryResult }) {
  const { t } = useAppTranslation();

  if (result.columns.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-xs">
        {result.affected === null
          ? t("database.window.done", { defaultValue: "Statement completed." })
          : t("database.window.affected", {
              count: result.affected,
              defaultValue: "{{count}} rows affected",
            })}
        {" · "}
        {Math.round(result.elapsedMs)} ms
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-[11px]">
        <span>
          {t("database.window.rowCount", {
            count: result.rows.length,
            defaultValue: "{{count}} rows",
          })}
        </span>
        <span>
          {Math.round(result.elapsedMs)} ms
          {result.executionMs < result.elapsedMs
            ? ` · ${t("database.window.executionTime", {
                ms: Math.round(result.executionMs),
              })}`
            : ""}
        </span>
        {result.hasMore && (
          <span className="text-foreground flex items-center gap-1">
            <AlertTriangle className="size-3" />
            {t("database.window.truncated", { defaultValue: "More rows are available." })}
          </span>
        )}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead className="bg-muted/60 sticky top-0">
          <tr>
            {result.columns.map((column, index) => (
              <th
                key={`${column.name}-${index}`}
                className="border-b px-2 py-1 text-left font-medium whitespace-nowrap"
              >
                <span className="block">{column.name}</span>
                <span className="text-muted-foreground block text-[10px] font-normal">
                  {column.typeName}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-accent/40">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={
                    cell === null
                      ? "text-muted-foreground border-b px-2 py-1 align-top italic"
                      : "border-b px-2 py-1 align-top font-mono break-all"
                  }
                >
                  {cell ?? "NULL"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
