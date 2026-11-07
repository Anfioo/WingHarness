import { memo } from "react";
import type { JSX } from "react";

import { useAppTranslation } from "@/hooks/use-app-translation";
import type { AgentMessageRow as AgentMessageRowData } from "@/features/agent-chat/types";
import { AgentGrantCard } from "./grant-card";
import { AgentMarkdownBody } from "./markdown-body";
import { AgentQuestionCard } from "./question-card";
import { AgentThinkingBlock } from "./thinking-block";
import { AgentToolCard } from "./tool-card";

function AgentMessageRowBase({ row }: { row: AgentMessageRowData }): JSX.Element {
  const { t } = useAppTranslation();

  switch (row.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="bg-primary/10 max-w-[85%] rounded-2xl px-4 py-2 text-sm break-words whitespace-pre-wrap">
            {row.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex justify-start">
          <div className="max-w-full min-w-0 text-sm">
            <AgentMarkdownBody text={row.text} />
            {row.live && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
          </div>
        </div>
      );
    case "thinking":
      return <AgentThinkingBlock row={row} />;
    case "tool":
      return <AgentToolCard row={row} />;
    case "question":
      return <AgentQuestionCard row={row} />;
    case "grant":
      return <AgentGrantCard row={row} />;
    case "error":
      return (
        <div className="border-destructive/40 bg-destructive/5 rounded-lg border px-3 py-2 text-sm">
          <div className="text-destructive mb-1 text-xs font-medium">
            {t("agentChat.message.error")}
          </div>
          <div className="break-words whitespace-pre-wrap">{row.message}</div>
        </div>
      );
  }
}

export const AgentMessageRow = memo(AgentMessageRowBase);
