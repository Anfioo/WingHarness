// The actions a result tab offers: run its statement again, fetch another
// page, count its rows. Each re-runs the statement on the server — the loaded
// page is only a window into the query.
//
// The window's store lives in a React context, which a plain module cannot
// read: `ResultTabs` binds the accessors once it is mounted.

import { databaseErrorCode, dbExecute, type SqlStatement } from "@/commands";
import i18n from "@/i18n";
import { toast } from "sonner";
import { pageFetch } from "./result-view";
import type { ResultTab } from "./store";

/** What the actions need from the mounted result tabs. */
export type ResultActionsContext = {
  sourceId: string;
  result(key: string, id: number): ResultTab | undefined;
  patch(key: string, id: number, patch: Partial<ResultTab>): void;
};

let bound: ResultActionsContext | null = null;

/** Hands the window's store to the actions; `null` unbinds on unmount. */
export function bindResultActions(context: ResultActionsContext | null): void {
  bound = context;
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

/** A cancelled query stops without a word; everything else is reported. */
function report(error: unknown): void {
  if (databaseErrorCode(error) === "cancelled") return;
  toast.error(failureText(error));
}

export async function rerunResult(key: string, resultId: number): Promise<void> {
  const context = bound;
  const tab = context?.result(key, resultId);
  if (!context || !tab || tab.busy || tab.plan !== null) return;
  context.patch(key, resultId, { busy: true, page: 0, total: null });
  try {
    const [outcome] = await dbExecute(
      crypto.randomUUID(),
      context.sourceId,
      [tab.statement],
      0,
      tab.pageSize
    );
    context.patch(key, resultId, { outcome: outcome ?? null, busy: false });
  } catch (error) {
    report(error);
    context.patch(key, resultId, { busy: false });
  }
}

export async function loadResultPage(
  key: string,
  resultId: number,
  page: number,
  pageSize: number
): Promise<void> {
  const context = bound;
  const tab = context?.result(key, resultId);
  if (!context || !tab || tab.busy || tab.plan !== null) return;
  const { maxRows, skip } = pageFetch(page, pageSize);
  context.patch(key, resultId, { busy: true });
  try {
    const [outcome] = await dbExecute(
      crypto.randomUUID(),
      context.sourceId,
      [tab.statement],
      skip,
      maxRows
    );
    context.patch(key, resultId, {
      outcome: outcome ?? null,
      page,
      pageSize,
      busy: false,
    });
  } catch (error) {
    report(error);
    context.patch(key, resultId, { busy: false });
  }
}

export async function countResult(key: string, resultId: number): Promise<void> {
  const context = bound;
  const tab = context?.result(key, resultId);
  if (!context || !tab || tab.busy || !tab.outcome?.result) return;
  // The statement's text is already trimmed and carries no trailing semicolon.
  const statement: SqlStatement = {
    ...tab.statement,
    text: `select count(*) from (\n${tab.statement.text}\n) q`,
  };
  context.patch(key, resultId, { busy: true });
  try {
    const [outcome] = await dbExecute(crypto.randomUUID(), context.sourceId, [statement], 0, 1);
    const text = outcome?.result?.rows[0]?.[0] ?? null;
    const total = text === null ? null : Number(text);
    context.patch(key, resultId, {
      busy: false,
      total: total !== null && Number.isFinite(total) ? total : null,
    });
  } catch (error) {
    report(error);
    context.patch(key, resultId, { busy: false });
  }
}
