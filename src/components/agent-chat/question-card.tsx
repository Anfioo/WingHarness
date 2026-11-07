import { memo, useState } from "react";
import type { JSX } from "react";
import { Check, MessageSquare } from "lucide-react";

import type { AgentAnswerMap } from "@/commands/services/agent-chat/types";
import { useAgentChatStore } from "@/features/agent-chat/store";
import type { AgentMessageRow } from "@/features/agent-chat/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

type QuestionRow = Extract<AgentMessageRow, { kind: "question" }>;

/** Sentinel for the free-text option; never sent as an answer itself. */
const OTHER = "\u0000other";

function OptionButton({
  active,
  multi,
  disabled,
  label,
  description,
  onClick,
}: {
  active: boolean;
  multi: boolean;
  disabled: boolean;
  label: string;
  description?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
        active ? "border-primary/60 bg-primary/5" : "hover:bg-accent",
        disabled && "cursor-default opacity-70"
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center border",
          multi ? "rounded-[4px]" : "rounded-full",
          active ? "border-primary bg-primary text-primary-foreground" : "border-border"
        )}
      >
        {active ? (
          multi ? (
            <Check className="size-3" />
          ) : (
            <span className="bg-primary-foreground size-1.5 rounded-full" />
          )
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="block break-words">{label}</span>
        {description ? (
          <span className="text-muted-foreground block text-xs">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

function AgentQuestionCardBase({ row }: { row: QuestionRow }): JSX.Element {
  const { t } = useAppTranslation();
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const answerQuestion = useAgentChatStore((state) => state.answerQuestion);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const pending = row.status === "pending";
  const multi = row.questions.some((question) => question.multiSelect);

  const collectAnswers = (): AgentAnswerMap => {
    const answers: AgentAnswerMap = {};
    for (const question of row.questions) {
      const key = question.question;
      const values = (selected[key] ?? [])
        .map((value) => (value === OTHER ? (others[key] ?? "").trim() : value))
        .filter((value) => value.length > 0);
      if (values.length === 0) continue;
      answers[key] = question.multiSelect ? values : values[0];
    }
    return answers;
  };

  const hasAnswer = Object.keys(collectAnswers()).length > 0;

  const toggle = (key: string, value: string, isMulti: boolean) => {
    setSelected((current) => {
      const values = current[key] ?? [];
      if (isMulti) {
        const next = values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value];
        return { ...current, [key]: next };
      }
      return { ...current, [key]: values.includes(value) ? [] : [value] };
    });
  };

  const submit = async (answers: AgentAnswerMap | null) => {
    if (!activeTabId || busy || !pending) return;
    setBusy(true);
    try {
      await answerQuestion(activeTabId, row.requestId, answers);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card rounded-lg border p-3">
      <header className="mb-2 flex items-center gap-2">
        <MessageSquare className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm font-medium">{t("agentChat.question.title")}</span>
        <span className="text-muted-foreground bg-muted ml-auto rounded px-1.5 py-0.5 font-mono text-[10px]">
          AskUserQuestion
        </span>
      </header>

      <div className="space-y-3">
        {row.questions.map((question) => {
          const key = question.question;
          const values = selected[key] ?? [];
          return (
            <div key={key}>
              {question.header ? (
                <div className="text-muted-foreground mb-0.5 text-[11px] font-medium tracking-wide uppercase">
                  {question.header}
                </div>
              ) : null}
              <div className="mb-2 text-sm">{question.question}</div>
              <div
                role={question.multiSelect ? "group" : "radiogroup"}
                aria-label={question.question}
                className="flex flex-col gap-1.5"
              >
                {question.options.map((option) => (
                  <OptionButton
                    key={option.label}
                    active={values.includes(option.label)}
                    multi={question.multiSelect}
                    disabled={!pending}
                    label={option.label}
                    description={option.description}
                    onClick={() => toggle(key, option.label, question.multiSelect)}
                  />
                ))}
                <OptionButton
                  active={values.includes(OTHER)}
                  multi={question.multiSelect}
                  disabled={!pending}
                  label={t("agentChat.question.other")}
                  onClick={() => toggle(key, OTHER, question.multiSelect)}
                />
              </div>
              {values.includes(OTHER) ? (
                <Textarea
                  value={others[key] ?? ""}
                  onChange={(event) =>
                    setOthers((current) => ({ ...current, [key]: event.target.value }))
                  }
                  placeholder={t("agentChat.question.otherPlaceholder")}
                  disabled={!pending}
                  className="mt-2 min-h-16 text-sm"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {pending && multi ? (
        <p className="text-muted-foreground mt-2 text-[11px]">
          {t("agentChat.question.multiHint")}
        </p>
      ) : null}

      {pending ? (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={busy || !activeTabId || !hasAnswer}
            onClick={() => {
              void submit(collectAnswers());
            }}
          >
            {t("agentChat.question.submit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !activeTabId}
            onClick={() => {
              void submit(null);
            }}
          >
            {t("agentChat.question.skip")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export const AgentQuestionCard = memo(AgentQuestionCardBase);
