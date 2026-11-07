// The execution side of a query tab: split the editor text into statements,
// run them on the engine, explain one of them, and write everything back to
// the window store.
//
// The window's store lives in a React context, which a plain module cannot
// read: `QueryTab` binds the accessors and the run state while it is mounted.

import { databaseErrorCode, dbCancel, dbExecute, dbExplain, dbStatements } from "@/commands";
import type { QueryResult, SqlStatement, StatementOutcome } from "@/commands";
import i18n from "@/i18n";
import { toast } from "sonner";
import type { OutputLine, ResultTab } from "./store";

/** What the runner needs from the mounted query tab. */
export type QueryRunnerContext = {
  sourceId: string;
  /** Rows fetched per statement: the row limit the console remembers. */
  consoleRows(): number;
  /** The result tabs of `key` as they are now. */
  results(key: string): ResultTab[];
  append(key: string, line: Omit<OutputLine, "id" | "time"> & { time?: number }): void;
  setResults(key: string, results: ResultTab[]): void;
  setActiveResult(key: string, id: number | "output"): void;
};

let bound: QueryRunnerContext | null = null;

/** Hands the store accessors to the runner; `null` unbinds on unmount. */
export function bindQueryRunner(context: QueryRunnerContext | null): void {
  bound = context;
}

/** The request id of the run in flight, one per query tab. */
const requests = new Map<string, string>();
const listeners = new Set<() => void>();

function notifyRunning(): void {
  for (const listener of listeners) listener();
}

/** Whether a run holds the query tab's engine slot. */
export function isRunning(tabKey: string): boolean {
  return requests.has(tabKey);
}

/** Subscribes to runs starting and finishing; returns the unsubscribe. */
export function subscribeRunning(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Result tab ids are only unique within the window; the store only compares them. */
let nextResultId = 1;

function newResultId(): number {
  return nextResultId++;
}

/** The text of a failure: the mapped code when there is one, the message otherwise. */
function failureText(error: unknown): string {
  const code = databaseErrorCode(error);
  if (code) {
    return i18n.t(`database.error.${code}`, {
      defaultValue: (error as { message: string }).message,
    });
  }
  return error instanceof Error ? error.message : String(error);
}

/** What a finished statement printed: its row count or affected rows, and its time. */
function resultSummary(result: QueryResult): string {
  const counts =
    result.columns.length > 0
      ? i18n.t("database.window.rowCount", { count: result.rows.length })
      : result.affected !== null
        ? i18n.t("database.window.affected", { count: result.affected })
        : i18n.t("database.window.done");
  return `${counts} · ${Math.round(result.elapsedMs)} ms`;
}

/** Writes one batch to the output log and appends a tab per result set. */
function writeOutcomes(
  context: QueryRunnerContext,
  tabKey: string,
  outcomes: StatementOutcome[]
): void {
  const pageSize = context.consoleRows();
  const added: ResultTab[] = [];
  let numbered = 0;

  for (const outcome of outcomes) {
    context.append(tabKey, { kind: "statement", text: outcome.statement.text });
    if (outcome.error) {
      context.append(tabKey, { kind: "error", text: failureText(outcome.error) });
      // The engine stops at the first failure; the statements after it never ran.
      break;
    }
    const result = outcome.result;
    if (!result) continue;
    context.append(tabKey, { kind: "result", text: resultSummary(result) });
    if (result.columns.length === 0) continue;

    numbered += 1;
    added.push({
      id: newResultId(),
      title: `${i18n.t("database.result.result")} ${numbered}`,
      statement: outcome.statement,
      outcome,
      plan: null,
      page: 0,
      pageSize,
      total: null,
      busy: false,
    });
  }

  if (added.length === 0) return;
  context.setResults(tabKey, [...context.results(tabKey), ...added]);
  context.setActiveResult(tabKey, added[added.length - 1]!.id);
}

/** Runs an already-split batch; a run replaces the one in flight for its tab. */
export async function runStatements(
  sourceId: string,
  tabKey: string,
  statements: SqlStatement[]
): Promise<void> {
  const context = bound;
  if (!context || statements.length === 0) return;

  const request = crypto.randomUUID();
  const previous = requests.get(tabKey);
  if (previous) void dbCancel(previous);
  requests.set(tabKey, request);
  notifyRunning();

  try {
    const outcomes = await dbExecute(request, sourceId, statements, 0, context.consoleRows());
    // The context is the one captured at the start: a tab switched away from
    // still gets its results, because the store outlives the mounted view.
    writeOutcomes(context, tabKey, outcomes);
  } catch (error) {
    if (databaseErrorCode(error) !== "cancelled") {
      const text = failureText(error);
      context.append(tabKey, { kind: "error", text });
      toast.error(text);
    }
  } finally {
    // A superseding run owns the slot now; it removes its own id.
    if (requests.get(tabKey) === request) {
      requests.delete(tabKey);
      notifyRunning();
    }
  }
}

/** Runs the statements of a document range: the selection, or the one at the caret. */
export async function runQuery(
  sourceId: string,
  tabKey: string,
  text: string,
  from: number,
  to: number
): Promise<void> {
  if (!bound) return;

  let statements: SqlStatement[];
  try {
    statements = await dbStatements(sourceId, text, from, to);
  } catch (error) {
    toast.error(failureText(error));
    return;
  }
  if (statements.length === 0) {
    toast.info(i18n.t("database.console.noStatement"));
    return;
  }
  await runStatements(sourceId, tabKey, statements);
}

/** Cancels the batch of `tabKey`; the run itself stays silent about it. */
export async function cancelQuery(_sourceId: string, tabKey: string): Promise<void> {
  const request = requests.get(tabKey);
  if (!request) return;
  try {
    await dbCancel(request);
  } catch {
    // The run in flight reports its own failure.
  }
}

/** Explains `statement` and shows the plan in a new tab of `tabKey`. */
export async function runPlan(sourceId: string, tabKey: string, statement: string): Promise<void> {
  const context = bound;
  if (!context) return;

  try {
    const plan = await dbExplain(sourceId, statement);
    const current = context.results(tabKey);
    const numbered = current.filter((tab) => tab.plan !== null).length + 1;
    const tab: ResultTab = {
      id: newResultId(),
      title: `${i18n.t("database.result.plan")} ${numbered}`,
      statement: { from: 0, to: statement.length, text: statement },
      outcome: null,
      plan,
      page: 0,
      pageSize: context.consoleRows(),
      total: null,
      busy: false,
    };

    context.append(tabKey, { kind: "statement", text: `EXPLAIN ${statement}` });
    context.append(tabKey, {
      kind: "result",
      text: `${i18n.t("database.plan.title")} · ${plan.length}`,
    });
    context.setResults(tabKey, [...current, tab]);
    context.setActiveResult(tabKey, tab.id);
  } catch (error) {
    if (databaseErrorCode(error) === "cancelled") return;
    const text = failureText(error);
    context.append(tabKey, { kind: "error", text });
    toast.error(text);
  }
}
