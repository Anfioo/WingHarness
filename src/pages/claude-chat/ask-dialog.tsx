/**
 * The dialog for a prompt the CLI is blocked on.
 *
 * Two shapes arrive on the same channel: `AskUserQuestion` (a set of questions
 * with options) and a tool-permission prompt (a tool about to run). Both need an
 * answer before the turn can continue, so this is a blocking overlay rather than
 * a dismissible dialog — it is a plain element with no escape hatch, and the
 * parent keys it by `requestId` so each prompt gets a fresh one.
 *
 * A countdown resolves the prompt if the user does not: questions fall back to
 * the model's "(Recommended)" option (or the first), a permission request is
 * denied. Granting a tool the user never looked at would be the wrong default.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, HelpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ControlQuestion, ControlRequest, ControlResponse } from "@/lib/use-claude/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/pages/mcp-hub/ui-bits";

/** What the CLI reports back when a prompt goes unanswered. */
const NO_ANSWER = "User did not provide answers";

/** Seconds before the dialog answers itself. */
const TIMEOUT_SECONDS = 120;

/** The model's convention for flagging its preferred option. */
const RECOMMENDED = /recommended|推荐/i;

/** Which option the countdown picks: the flagged one, else the first. */
function recommendedIndex(question: ControlQuestion): number {
  const index = question.options.findIndex((option) => RECOMMENDED.test(option.label));
  return index >= 0 ? index : 0;
}

/** Fill every unanswered question with its default option. */
function withDefaults(
  request: ControlRequest,
  answers: Record<string, string | string[]>
): Record<string, string | string[]> {
  const filled = { ...answers };
  for (const question of request.questions) {
    if (filled[question.question] !== undefined) continue;
    const pick = question.options[recommendedIndex(question)].label;
    filled[question.question] = question.multiSelect ? [pick] : pick;
  }
  return filled;
}

export function AskDialog({
  request,
  onRespond,
}: {
  request: ControlRequest;
  onRespond: (response: ControlResponse) => void;
}) {
  const { t } = useAppTranslation();
  const isQuestion = request.questions.length > 0;

  // The CLI's own permission suggestions, when it made any. They are not always
  // "always allow this tool": depending on the request they can switch the
  // session's mode, widen the allowed directories, or add an allow rule, so the
  // dialog offers them by what they are rather than under a fixed label.
  const suggestions =
    Array.isArray(request.permissionSuggestions) && request.permissionSuggestions.length > 0
      ? request.permissionSuggestions
      : null;

  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [applySuggestions, setApplySuggestions] = useState(false);
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);
  const answeredRef = useRef(false);

  // The countdown must read the latest selections without restarting, and
  // `answer` must stay stable or the interval would be re-armed on every render.
  // Both go through a ref that is synced in an effect rather than during render.
  const latestRef = useRef({ request, answers, onRespond });
  useEffect(() => {
    latestRef.current = { request, answers, onRespond };
  });

  // Answering happens exactly once — the countdown and the buttons race for it.
  const answer = useCallback((response: ControlResponse) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    latestRef.current.onRespond(response);
  }, []);

  useEffect(() => {
    const deadline = Date.now() + TIMEOUT_SECONDS * 1000;
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left > 0) return;
      window.clearInterval(id);
      const current = latestRef.current;
      answer(
        current.request.questions.length === 0
          ? { behavior: "deny", message: NO_ANSWER }
          : {
              behavior: "allow",
              updatedInput: {
                ...current.request.input,
                answers: withDefaults(current.request, current.answers),
              },
            }
      );
    }, 250);
    return () => window.clearInterval(id);
  }, [answer]);

  const submitAnswers = useCallback(() => {
    answer({
      behavior: "allow",
      updatedInput: { ...request.input, answers: withDefaults(request, answers) },
    });
  }, [answer, request, answers]);

  const selectOne = (question: ControlQuestion, label: string) =>
    setAnswers((prev) => ({ ...prev, [question.question]: label }));

  const toggleOne = (question: ControlQuestion, label: string) =>
    setAnswers((prev) => {
      const current = prev[question.question];
      const list = Array.isArray(current) ? current : [];
      const next = list.includes(label) ? list.filter((item) => item !== label) : [...list, label];
      return { ...prev, [question.question]: next };
    });

  return (
    <div className="bg-background/60 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="border-border bg-card text-card-foreground w-full max-w-2xl overflow-hidden rounded-xl border shadow-lg"
      >
        <header className="border-border flex items-start gap-3 border-b p-4">
          <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full">
            {isQuestion ? <HelpCircle className="size-4" /> : <AlertTriangle className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">
              {isQuestion ? t("claudeChat.askTitle") : t("claudeChat.askPermissionTitle")}
            </h2>
            <p className="text-muted-foreground text-xs">
              {isQuestion
                ? t("claudeChat.askCountdown", { seconds: remaining })
                : t("claudeChat.askPermissionCountdown", { seconds: remaining })}
            </p>
          </div>
        </header>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          {isQuestion ? (
            <div className="flex flex-col gap-4">
              {request.questions.map((question) => {
                const value = answers[question.question];
                return (
                  <div key={question.question} className="flex flex-col gap-2">
                    {question.header && (
                      <span className="text-muted-foreground text-[0.7rem] font-medium tracking-wide uppercase">
                        {question.header}
                      </span>
                    )}
                    <p className="text-sm font-medium">{question.question}</p>
                    {question.multiSelect && (
                      <p className="text-muted-foreground text-xs">
                        {t("claudeChat.askMultiHint")}
                      </p>
                    )}
                    <div className="flex flex-col gap-1.5">
                      {question.options.map((option, index) => {
                        const checked = question.multiSelect
                          ? Array.isArray(value) && value.includes(option.label)
                          : value === option.label;
                        return (
                          <label
                            key={option.label}
                            className={cn(
                              "border-border hover:bg-muted/50 flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5",
                              checked && "border-primary bg-primary/5"
                            )}
                          >
                            <input
                              type={question.multiSelect ? "checkbox" : "radio"}
                              name={question.question}
                              className="accent-primary mt-0.5"
                              checked={checked}
                              onChange={() =>
                                question.multiSelect
                                  ? toggleOne(question, option.label)
                                  : selectOne(question, option.label)
                              }
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{option.label}</span>
                                {index === recommendedIndex(question) && (
                                  <Badge tone="green">{t("claudeChat.askRecommended")}</Badge>
                                )}
                              </span>
                              {option.description && (
                                <span className="text-muted-foreground mt-0.5 block text-xs">
                                  {option.description}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                {t("claudeChat.askPermissionBody", { tool: request.toolName })}
              </p>
              <p className="text-muted-foreground text-xs">{t("claudeChat.askPermissionHint")}</p>
              <pre className="bg-muted max-h-56 overflow-auto rounded-lg p-2.5 font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify(request.input, null, 2)}
              </pre>
              {suggestions && (
                <label className="border-border hover:bg-muted/50 mt-1 flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5">
                  <input
                    type="checkbox"
                    className="accent-primary mt-0.5"
                    checked={applySuggestions}
                    onChange={(event) => setApplySuggestions(event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {t("claudeChat.askApplySuggestions")}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {t("claudeChat.askApplySuggestionsHint")}
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}
        </div>

        <footer className="border-border flex justify-end gap-2 border-t p-4">
          {isQuestion ? (
            <Button size="sm" onClick={submitAnswers}>
              <Check className="size-4" />
              {t("claudeChat.askContinue")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => answer({ behavior: "deny", message: NO_ANSWER })}
              >
                <X className="size-4" />
                {t("claudeChat.askDeny")}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  answer({
                    behavior: "allow",
                    updatedInput: request.input,
                    // Verbatim on purpose: the CLI validates these entries, and
                    // reshaping them would only add a second place to get wrong.
                    ...(applySuggestions && suggestions ? { updatedPermissions: suggestions } : {}),
                  })
                }
              >
                <Check className="size-4" />
                {t("claudeChat.askAllow")}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
